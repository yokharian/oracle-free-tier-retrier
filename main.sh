#!/bin/bash
# oci-create-vms-per-ad.sh
# Unified script: Deploy VMs using Terraform (Resource Manager) or OCI CLI directly
# Compatible with macOS (BSD) and Ubuntu (GNU)

set -euo pipefail

# Cross-platform colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { printf "${GREEN}%s${NC}\n" "$1"; }
log_warn()    { printf "${YELLOW}%s${NC}\n" "$1"; }
log_error()   { printf "${RED}%s${NC}\n" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TFVARS_FILE="$SCRIPT_DIR/terraform.tfvars"
ENV_FILE="$SCRIPT_DIR/.env"
SLEEP_SECONDS=900

# --- Prerequisites ---
require_cmd() {
    command -v "$1" >/dev/null 2>&1 || { log_error "Error: Missing required command: $1"; exit 1; }
}

check_prerequisites() {
    require_cmd oci
    require_cmd jq
    require_cmd awk
    log_warn "Checking OCI CLI authentication..."
    if ! oci os ns get >/dev/null 2>&1; then
        log_error "Error: OCI CLI is not properly configured. Run 'oci setup config' first."
        exit 1
    fi
    log_info "OCI CLI authenticated"
    echo ""
}

load_tfvars() {
    if [[ ! -f "$TFVARS_FILE" ]]; then
        log_error "Error: terraform.tfvars not found at $TFVARS_FILE"
        log_warn "Copy terraform.tfvars.example to terraform.tfvars and fill in your values."
        exit 1
    fi
    log_warn "Loading terraform.tfvars..."
    log_info "Variables loaded"
    echo ""
}

load_env() {
    OCI_NETWORKING_STACK_ID=""
    OCI_COMPUTE_STACK_ID=""
    if [[ -f "$ENV_FILE" ]]; then
        set -a
        source "$ENV_FILE"
        set +a
        log_warn "Loading .env..."
        if [[ -n "${OCI_NETWORKING_STACK_ID:-}" ]]; then
            log_info "Networking stack OCID: $OCI_NETWORKING_STACK_ID"
        fi
        if [[ -n "${OCI_COMPUTE_STACK_ID:-}" ]]; then
            log_info "Compute stack OCID: $OCI_COMPUTE_STACK_ID"
        fi
        echo ""
    fi
}

parse_tfvar() {
    local key="$1"
    awk -F'"' "/^${key}[[:space:]]*=/ {print \$2}" "$TFVARS_FILE" | head -1
}

get_compartment_id() {
    parse_tfvar "compartment_id"
}

get_instance_name() {
    parse_tfvar "instance_name"
}

validate_compartment_id() {
    local compartment_id="$1"
    if [[ -z "$compartment_id" ]]; then
        log_error "Error: compartment_id is empty in terraform.tfvars"
        exit 1
    fi
    if [[ "$compartment_id" != ocid1.compartment.* && "$compartment_id" != ocid1.tenancy.* ]]; then
        log_error "Error: compartment_id does not look valid: $compartment_id"
        log_warn "Expected format: ocid1.compartment.oc1.. or ocid1.tenancy.oc1.."
        exit 1
    fi
}

find_stack_by_name() {
    local compartment_id="$1"
    local display_name="$2"
    oci resource-manager stack list \
        --compartment-id "$compartment_id" \
        --display-name "$display_name" \
        --lifecycle-state ACTIVE \
        --query 'data[0].id' \
        --raw-output 2>/dev/null || true
}

# ==========================================
# OPTION 1: Terraform via Resource Manager
# ==========================================

ADS=()

get_all_ads() {
    log_warn "Fetching all Availability Domains..."
    local compartment_id
    compartment_id=$(get_compartment_id)
    validate_compartment_id "$compartment_id"

    local ads_json
    ads_json=$(oci iam availability-domain list --compartment-id "$compartment_id")
    local count
    count=$(echo "$ads_json" | jq '.data | length')

    if [[ "$count" -eq 0 ]]; then
        log_error "Error: No Availability Domains found."
        exit 1
    fi

    ADS=()
    for i in $(seq 0 $((count - 1))); do
        ADS+=("$(echo "$ads_json" | jq -r ".data[$i].name")")
    done
    log_info "Found ${#ADS[@]} Availability Domain(s)"
}

vm_exists() {
    local compartment_id instance_name vm_id
    compartment_id=$(get_compartment_id)
    instance_name=$(get_instance_name)
    vm_id=$(oci compute instance list \
        --compartment-id "$compartment_id" \
        --display-name "$instance_name" \
        --query 'data[?contains(["PROVISIONING","STARTING","RUNNING","STOPPING","STOPPED"], "lifecycle-state")].id | [0]' \
        --raw-output 2>/dev/null || true)
    [[ -n "${vm_id:-}" && "$vm_id" != "null" ]]
}

latest_job_state() {
    local stack_id="$1"
    oci resource-manager job list \
        --stack-id "$stack_id" \
        --sort-by TIMECREATED \
        --sort-order DESC \
        --limit 1 \
        --query 'data[0]."lifecycle-state"' \
        --raw-output 2>/dev/null || true
}

wait_for_job() {
    local stack_id="$1"
    while true; do
        local state
        state=$(latest_job_state "$stack_id")
        printf "  State: %s\n" "${state:-none}"
        case "$state" in
            SUCCEEDED) return 0 ;;
            FAILED|CANCELLED) return 1 ;;
            *) sleep 30 ;;
        esac
    done
}

create_apply_job() {
    local stack_id="$1"
    oci resource-manager job create-apply-job \
        --stack-id "$stack_id" \
        --execution-plan-strategy AUTO_APPROVED
}

cancel_job() {
    local stack_id="$1"
    local job_id
    job_id=$(oci resource-manager job list \
        --stack-id "$stack_id" \
        --sort-by TIMECREATED \
        --sort-order DESC \
        --limit 1 \
        --query 'data[?contains(["ACCEPTED","IN_PROGRESS"],"lifecycle-state")].id | [0]' \
        --raw-output 2>/dev/null || true)
    if [[ -n "${job_id:-}" && "$job_id" != "null" ]]; then
        printf "  Cancelling job %s\n" "$job_id"
        oci resource-manager job cancel --job-id "$job_id" --force 2>/dev/null || true
    fi
}

get_stack_outputs() {
    local stack_id="$1"
    oci resource-manager stack get \
        --stack-id "$stack_id" \
        --query 'data."terraform-state".outputs' \
        --raw-output 2>/dev/null || echo "{}"
}

get_output_value() {
    local outputs="$1" key="$2"
    echo "$outputs" | jq -r ".${key}.value // empty" 2>/dev/null
}

deploy_networking() {
    local existing_id="${1:-}"
    local compartment_id
    compartment_id=$(get_compartment_id)

    if [[ -n "$existing_id" ]]; then
        printf "Using existing networking stack: %s\n" "$existing_id"
        local state
        state=$(latest_job_state "$existing_id")
        printf "Current state: %s\n" "$state"
        if [[ "$state" != "SUCCEEDED" ]]; then
            printf "Applying networking stack...\n"
            create_apply_job "$existing_id"
            if ! wait_for_job "$existing_id"; then
                log_error "Networking stack failed."
                exit 1
            fi
        fi
        echo "$existing_id"
        return
    fi

    printf "Copying terraform.tfvars to networking module...\n"
    cp "$TFVARS_FILE" "$SCRIPT_DIR/networking/terraform.tfvars"

    local zip_path="$SCRIPT_DIR/networking.zip"
    rm -f "$zip_path"
    zip_module "$SCRIPT_DIR/networking" "$zip_path"

    printf "Creating new networking stack...\n"
    local stack_id
    stack_id=$(oci resource-manager stack create \
        --compartment-id "$compartment_id" \
        --config-source "$zip_path" \
        --display-name "networking-stack" \
        --description "VCN, subnet, IGW, route table" \
        --query 'data.id' \
        --raw-output)
    printf "  Stack created: %s\n" "$stack_id"
    rm -f "$zip_path"

    printf "Applying networking stack...\n"
    create_apply_job "$stack_id"
    if ! wait_for_job "$stack_id"; then
        log_error "Networking stack failed."
        exit 1
    fi
    log_info "  Networking applied successfully."
    echo "$stack_id"
}

deploy_compute() {
    local net_stack_id="$1"
    local compartment_id
    compartment_id=$(get_compartment_id)

    printf "Fetching networking outputs...\n"
    local outputs
    outputs=$(get_stack_outputs "$net_stack_id")
    local subnet_name
    subnet_name=$(get_output_value "$outputs" "subnet_display_name")

    if [[ -z "$subnet_name" ]]; then
        log_error "ERROR: Could not get subnet_display_name from networking outputs."
        exit 1
    fi
    printf "  Subnet: %s\n" "$subnet_name"

    printf "Copying terraform.tfvars to compute module...\n"
    cp "$TFVARS_FILE" "$SCRIPT_DIR/compute/terraform.tfvars"

    local zip_path="$SCRIPT_DIR/compute.zip"
    rm -f "$zip_path"
    zip_module "$SCRIPT_DIR/compute" "$zip_path"

    printf "Creating new compute stack...\n"
    local stack_id
    stack_id=$(oci resource-manager stack create \
        --compartment-id "$compartment_id" \
        --config-source "$zip_path" \
        --display-name "compute-stack" \
        --description "Compute instance with AD retry" \
        --variables "{\"subnet_display_name\":\"$subnet_name\"}" \
        --query 'data.id' \
        --raw-output)
    printf "  Stack created: %s\n" "$stack_id"
    rm -f "$zip_path"
    echo "$stack_id"
}

destroy_stacks() {
    printf "${CYAN}=== Destroying stacks ===${NC}\n"
    load_env

    local compartment_id
    compartment_id=$(get_compartment_id)
    validate_compartment_id "$compartment_id"

    local net_id comp_id

    if [[ -n "${OCI_NETWORKING_STACK_ID:-}" ]]; then
        net_id="$OCI_NETWORKING_STACK_ID"
    else
        net_id=$(find_stack_by_name "$compartment_id" "networking-stack")
    fi

    if [[ -n "${OCI_COMPUTE_STACK_ID:-}" ]]; then
        comp_id="$OCI_COMPUTE_STACK_ID"
    else
        comp_id=$(find_stack_by_name "$compartment_id" "compute-stack")
    fi

    if [[ -z "$net_id" || "$net_id" == "null" ]] && [[ -z "$comp_id" || "$comp_id" == "null" ]]; then
        printf "No stacks found. Set OCI_NETWORKING_STACK_ID or OCI_COMPUTE_STACK_ID in .env, or create stacks first.\n"
        return
    fi

    if [[ -n "$comp_id" && "$comp_id" != "null" ]]; then
        printf "Destroying compute stack: %s\n" "$comp_id"
        cancel_job "$comp_id"
        oci resource-manager stack delete --stack-id "$comp_id" --force 2>/dev/null || true
    fi

    if [[ -n "$net_id" && "$net_id" != "null" ]]; then
        printf "Destroying networking stack: %s\n" "$net_id"
        cancel_job "$net_id"
        oci resource-manager stack delete --stack-id "$net_id" --force 2>/dev/null || true
    fi
}

retry_compute_loop() {
    local compute_stack_id="$1"
    local instance_name
    instance_name=$(get_instance_name)

    echo ""
    printf "${CYAN}=== Compute retry loop ===${NC}\n"
    printf "Stack: %s\n" "$compute_stack_id"
    printf "VM: %s\n" "$instance_name"
    echo ""

    while true; do
        printf "[%s] Checking if VM exists...\n" "$(date)"
        if vm_exists; then
            log_info "VM '$instance_name' already exists. Done."
            exit 0
        fi

        local state
        state=$(latest_job_state "$compute_stack_id")
        printf "Last job state: %s\n" "${state:-none}"

        case "${state:-none}" in
            ACCEPTED|IN_PROGRESS|CANCELING)
                printf "Job in progress. Waiting %ss.\n" "$SLEEP_SECONDS"
                sleep "$SLEEP_SECONDS"
                continue
                ;;
        esac

        for ad in "${ADS[@]}"; do
            echo ""
            printf "Trying availability_domain=%s\n" "$ad"
            oci resource-manager stack update \
                --stack-id "$compute_stack_id" \
                --variables "{\"availability_domain\":\"$ad\"}" \
                --force

            set +e
            local output rc
            output=$(create_apply_job "$compute_stack_id" 2>&1)
            rc=$?
            set -e
            echo "$output"

            if vm_exists; then
                log_info "VM '$instance_name' was created. Done."
                exit 0
            fi

            if [[ $rc -eq 0 ]]; then
                printf "  Apply sent for %s. Waiting %ss...\n" "$ad" "$SLEEP_SECONDS"
                sleep "$SLEEP_SECONDS"
                if vm_exists; then
                    log_info "VM '$instance_name' exists after applying $ad."
                    exit 0
                fi
            else
                log_warn "Apply failed for $ad. Trying next AD."
            fi
        done

        printf "No AD succeeded. Waiting %ss before retry cycle.\n" "$SLEEP_SECONDS"
        sleep "$SLEEP_SECONDS"
    done
}

deploy_terraform() {
    load_tfvars
    load_env
    get_all_ads

    local net_id comp_id

    if [[ -n "${OCI_NETWORKING_STACK_ID:-}" ]]; then
        printf "${CYAN}=== Networking Stack ===${NC}\n"
        printf "Using existing stack from .env: %s\n" "$OCI_NETWORKING_STACK_ID"
        net_id=$(deploy_networking "$OCI_NETWORKING_STACK_ID")
    else
        printf "${CYAN}=== Networking Stack ===${NC}\n"
        printf "[1] Create new networking stack from local files\n"
        printf "[2] Use existing Resource Manager stack OCID\n"
        read -p "Choose [1/2]: " net_choice

        case "$net_choice" in
            1) net_id=$(deploy_networking) ;;
            2)
                read -p "Enter networking stack OCID: " existing_net_id
                net_id=$(deploy_networking "$existing_net_id")
                ;;
            *) log_error "Invalid choice."; exit 1 ;;
        esac
    fi

    echo ""

    if [[ -n "${OCI_COMPUTE_STACK_ID:-}" ]]; then
        printf "${CYAN}=== Compute Stack ===${NC}\n"
        printf "Using existing stack from .env: %s\n" "$OCI_COMPUTE_STACK_ID"
        comp_id="$OCI_COMPUTE_STACK_ID"
    else
        printf "${CYAN}=== Compute Stack ===${NC}\n"
        comp_id=$(deploy_compute "$net_id")
    fi

    echo ""
    printf "${CYAN}=== Stack IDs ===${NC}\n"
    printf "  Networking: %s\n" "$net_id"
    printf "  Compute:    %s\n" "$comp_id"
    printf "\nCopy these to .env for subsequent runs:\n"
    printf "  OCI_NETWORKING_STACK_ID=%s\n" "$net_id"
    printf "  OCI_COMPUTE_STACK_ID=%s\n" "$comp_id"
    echo ""

    retry_compute_loop "$comp_id"
}

# ==========================================
# OPTION 2: OCI CLI Direct
# ==========================================

prompt_compartment() {
    log_warn "Fetching compartments..."
    compartments=$(oci iam compartment list --compartment-id-in-subtree true --all 2>/dev/null)

    local data_length=0
    if [[ -n "$compartments" ]]; then
        data_length=$(echo "$compartments" | jq '.data | length')
    fi

    if [[ "$data_length" -eq 0 ]]; then
        log_warn "No child compartments found. Using tenancy root as compartment."
        COMPARTMENT_ID=$(grep '^tenancy=' ~/.oci/config | cut -d'=' -f2)
        COMPARTMENT_NAME="Root (Tenancy)"
        log_info "Selected: $COMPARTMENT_NAME ($COMPARTMENT_ID)"
        echo ""
        return
    fi

    echo ""
    printf "Available compartments:\n"
    echo "$compartments" | jq -r '.data[] | "\(.name) [\(.id)]"' | nl -w2 -s') '

    read -p "Select compartment number (1-$data_length): " choice

    COMPARTMENT_ID=$(echo "$compartments" | jq -r ".data[$((choice-1))].id")
    COMPARTMENT_NAME=$(echo "$compartments" | jq -r ".data[$((choice-1))].name")
    log_info "Selected: $COMPARTMENT_NAME"
    echo ""
}

prompt_subnet() {
    log_warn "Fetching subnets in compartment..."
    subnets=$(oci network subnet list --compartment-id "$COMPARTMENT_ID" --all 2>/dev/null)

    local data_length=0
    if [[ -n "$subnets" ]]; then
        data_length=$(echo "$subnets" | jq '.data | length')
    fi

    if [[ "$data_length" -eq 0 ]]; then
        echo ""
        log_warn "No subnets found in this compartment."
        read -p "Deploy VCN + subnet using Terraform (networking/)? (Y/n): " deploy_choice
        if [[ ! "$deploy_choice" =~ ^[Nn]$ ]]; then
            SUBNET_ID=$(deploy_cli_networking)
            return
        else
            log_error "Cannot proceed without a subnet."
            exit 1
        fi
    fi

    echo ""
    printf "Available subnets:\n"
    echo "$subnets" | jq -r '.data[] | "\(.["display-name"] // "(unnamed)") - \(.["cidr-block"] // .["cidr"]) [\(.id)]"' | nl -w2 -s') '

    read -p "Select subnet number (1-$data_length): " choice

    SUBNET_ID=$(echo "$subnets" | jq -r ".data[$((choice-1))].id")
    log_info "Subnet selected"
    echo ""
}

zip_module() {
    local module_dir="$1"
    local zip_file="$2"
    (cd "$module_dir" && zip -rq "$zip_file" .)
}

deploy_cli_networking() {
    log_warn "Deploying VCN + subnet using Terraform..."

    printf "Copying terraform.tfvars to networking module...\n"
    cp "$TFVARS_FILE" "$SCRIPT_DIR/networking/terraform.tfvars"

    local zip_path="$SCRIPT_DIR/networking.zip"
    rm -f "$zip_path"
    zip_module "$SCRIPT_DIR/networking" "$zip_path"

    local compartment_id
    compartment_id=$(get_compartment_id)

    printf "Creating networking stack...\n"
    local stack_id
    stack_id=$(oci resource-manager stack create \
        --compartment-id "$compartment_id" \
        --config-source "$zip_path" \
        --display-name "networking-stack" \
        --description "VCN, subnet, IGW, route table" \
        --query 'data.id' \
        --raw-output)
    printf "  Stack created: %s\n" "$stack_id"
    rm -f "$zip_path"

    printf "Applying networking stack...\n"
    oci resource-manager job create-apply-job \
        --stack-id "$stack_id" \
        --execution-plan-strategy AUTO_APPROVED >/dev/null

    while true; do
        local state
        state=$(oci resource-manager job list \
            --stack-id "$stack_id" \
            --sort-by TIMECREATED \
            --sort-order DESC \
            --limit 1 \
            --query 'data[0]."lifecycle-state"' \
            --raw-output 2>/dev/null || true)
        printf "  State: %s\n" "${state:-none}"
        case "$state" in
            SUCCEEDED) break ;;
            FAILED|CANCELLED)
                log_error "Networking stack failed."
                exit 1
                ;;
            *) sleep 30 ;;
        esac
    done

    log_info "Networking applied successfully."

    local subnet_id
    subnet_id=$(oci resource-manager stack get \
        --stack-id "$stack_id" \
        --query 'data."terraform-state".outputs.subnet_id.value' \
        --raw-output 2>/dev/null)

    if [[ -z "$subnet_id" || "$subnet_id" == "null" ]]; then
        log_error "Could not retrieve subnet OCID from stack outputs."
        exit 1
    fi

    printf "\nNetworking stack OCID: %s\n" "$stack_id"
    printf "Add to .env for future use: OCI_NETWORKING_STACK_ID=%s\n\n" "$stack_id"

    log_info "Subnet created: $subnet_id"
    echo "$subnet_id"
}

prompt_image() {
    log_warn "Fetching Ubuntu images..."
    images=$(oci compute image list --compartment-id "$COMPARTMENT_ID" --operating-system "Canonical Ubuntu" --sort-by TIMECREATED --sort-order DESC --all 2>/dev/null)

    if [ -z "$images" ] || [ "$(echo "$images" | jq '.data | length')" -eq 0 ]; then
        log_error "Error: No Canonical Ubuntu images found."
        exit 1
    fi

    echo ""
    printf "Available Canonical Ubuntu images (showing top 10):\n"
    echo "$images" | jq -r '.data[:10] | .[] | "\(.["display-name"]) [\(.id)]"' | nl -w2 -s') '

    read -p "Select image number (1-10): " choice

    IMAGE_ID=$(echo "$images" | jq -r ".data[$((choice-1))].id")
    IMAGE_NAME=$(echo "$images" | jq -r ".data[$((choice-1))].\"display-name\"")
    log_info "Selected: $IMAGE_NAME"
    echo ""
}

prompt_shape_config() {
    log_warn "Instance Configuration:"
    read -p "Shape (default: VM.Standard.A1.Flex): " shape
    SHAPE=${shape:-VM.Standard.A1.Flex}

    read -p "OCPUs (default: 1): " ocpus
    OCPUS=${ocpus:-1}

    read -p "Memory in GBs (default: 4): " memory
    MEMORY=${memory:-4}

    log_info "Shape: $SHAPE, OCPUs: $OCPUS, Memory: ${MEMORY}GB"
    echo ""
}

prompt_ssh_key() {
    read -p "SSH public key file path (leave empty to skip): " ssh_key_path

    SSH_PUBLIC_KEY=""
    if [ -n "$ssh_key_path" ] && [ -f "$ssh_key_path" ]; then
        SSH_PUBLIC_KEY=$(cat "$ssh_key_path")
        log_info "SSH key loaded"
    elif [ -n "$ssh_key_path" ]; then
        log_warn "File not found, skipping SSH key"
    fi
    echo ""
}

prompt_instance_name() {
    read -p "Instance name prefix (default: vm): " prefix
    INSTANCE_PREFIX=${prefix:-vm}
    echo ""
}

deploy_cli() {
    prompt_compartment
    prompt_subnet
    prompt_image
    prompt_shape_config
    prompt_ssh_key
    prompt_instance_name

    log_warn "Fetching Availability Domains..."
    ads=$(oci iam availability-domain list --compartment-id "$COMPARTMENT_ID")
    ad_count=$(echo "$ads" | jq '.data | length')

    if [ "$ad_count" -eq 0 ]; then
        log_error "Error: No Availability Domains found."
        exit 1
    fi

    log_info "Found $ad_count Availability Domain(s)"
    echo ""

    log_warn "Summary:"
    printf "  Compartment: %s\n" "$COMPARTMENT_NAME"
    printf "  Subnet: %s\n" "$SUBNET_ID"
    printf "  Image: %s\n" "$IMAGE_ID"
    printf "  Shape: %s (OCPUs: %s, Memory: %sGB)\n" "$SHAPE" "$OCPUS" "$MEMORY"
    printf "  Instances: %s (one per AD)\n" "$ad_count"
    echo ""

    read -p "Proceed with instance creation? (y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        printf "Aborted.\n"
        exit 0
    fi

    echo ""
    log_info "Launching instances..."
    echo ""

    declare -a CREATED_ADS=()
    declare -a CREATED_IDS=()
    declare -a FAILED_ADS=()

    while [[ ${#CREATED_ADS[@]} -lt $ad_count ]]; do
        for i in $(seq 0 $((ad_count - 1))); do
            ad_name=$(echo "$ads" | jq -r ".data[$i].name")

            # Skip already created
            already_created=false
            for created in "${CREATED_ADS[@]+"${CREATED_ADS[@]}"}"; do
                if [[ "$created" == "$ad_name" ]]; then
                    already_created=true
                    break
                fi
            done
            if $already_created; then
                log_info "Skipping $ad_name (already created)"
                continue
            fi

            instance_name="${INSTANCE_PREFIX}-$(echo "$ad_name" | sed 's/.*AD-\([0-9]\)/\1/')"

            log_warn "Launching $instance_name in $ad_name..."

            launch_cmd=(
                oci compute instance launch
                --availability-domain "$ad_name"
                --compartment-id "$COMPARTMENT_ID"
                --shape "$SHAPE"
                --subnet-id "$SUBNET_ID"
                --image-id "$IMAGE_ID"
                --display-name "$instance_name"
                --shape-config "{\"ocpus\": $OCPUS, \"memory_in_gbs\": $MEMORY}"
                --assign-public-ip true
                --wait-for-state RUNNING
                --max-wait-seconds 600
            )

            if [ -n "$SSH_PUBLIC_KEY" ]; then
                launch_cmd+=(--metadata "{\"ssh_authorized_keys\": \"$SSH_PUBLIC_KEY\"}")
            fi

            set +e
            output=$("${launch_cmd[@]}" 2>&1)
            rc=$?
            set -e

            if [[ $rc -eq 0 ]]; then
                instance_ocid=$(echo "$output" | jq -r '.data.id')
                CREATED_ADS+=("$ad_name")
                CREATED_IDS+=("$instance_ocid")
                log_info "  $instance_name created: $instance_ocid"
            else
                FAILED_ADS+=("$ad_name")
                log_error "  Failed to create $instance_name in $ad_name"
                echo "$output" | tail -5
            fi
            echo ""
        done

        # Check if all succeeded
        if [[ ${#CREATED_ADS[@]} -lt $ad_count ]]; then
            log_warn "${#FAILED_ADS[@]} AD(s) failed. Retrying in ${SLEEP_SECONDS}s..."
            log_warn "Failed ADs: ${FAILED_ADS[*]}"
            FAILED_ADS=()
            sleep "$SLEEP_SECONDS"
        fi
    done

    log_info "=== Summary ==="
    printf "Successful: %d\n" "${#CREATED_ADS[@]}"
    echo ""
    printf "Instance Details:\n"
    for idx in "${!CREATED_ADS[@]}"; do
        printf "  %s: %s\n" "${CREATED_ADS[$idx]}" "${CREATED_IDS[$idx]}"
    done
}

# ==========================================
# Main Menu
# ==========================================

check_prerequisites

printf "${GREEN}========================================${NC}\n"
printf "${GREEN}  OCI VM Instance Generator${NC}\n"
printf "${GREEN}========================================${NC}\n"
echo ""
printf "[1] Deploy using Terraform (Resource Manager)\n"
printf "[2] Deploy using OCI CLI directly\n"
printf "[3] Destroy Resource Manager stacks\n"
echo ""
read -p "Enter choice [1/2/3]: " choice

case "$choice" in
    1) deploy_terraform ;;
    2) deploy_cli ;;
    3) destroy_stacks ;;
    *) log_error "Invalid choice."; exit 1 ;;
esac
