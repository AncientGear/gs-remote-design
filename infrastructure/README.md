# Disposable EC2 canvas smoke test

Run `bash infrastructure/smoke.sh` from this repository. This creates **paid AWS resources** using profile `ahau-2026`, region `us-east-1`, with SSH and remote access restricted to `189.215.51.112/32`. It ignores configured AWS endpoint overrides (including LocalStack).

Requires Terraform >=1.6, AWS CLI credentials, Node/npm, OpenSSH, curl, tar and GNU `timeout`. The local public egress IP must match the allowlist. Playwright downloads Chromium into the private run directory; the host must provide its OS dependencies.

The module creates an isolated VPC, subnet, Internet gateway, route table, security group, ephemeral SSH public key and Ubuntu `t3.small` with an encrypted disposable root disk. No IAM instance role, existing VPC, or production data is used.

The runner verifies an official Node 22 binary checksum, installs npm's current stable `gentle-pi` and Pi, uploads this local extension, creates an existing design fixture, and opens it through Gentle Shell RPC without LLM credentials. The browser logs in and asserts the real iframe heading and session-cookie properties, saving a screenshot. This tests viewing, not agent-triggering design actions.

## Cleanup and evidence

An EXIT/INT/TERM trap invokes `terraform destroy` after apply starts, including failed tests. Before destroy, optional SSH log collection has a 15-second deadline plus a 5-second kill grace; a failed or stalled collection does not prevent cleanup or replace the test exit status. A successful run reports both browser success and zero managed resources. No shell trap can handle SIGKILL or host loss: retain `.runs/test-*` and inspect `destroy.log` / `terraform.tfstate` if interrupted. Do not run two destroy operations against the same state.

For manual recovery, use the failed run's directory and provider data:

```bash
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true
export TF_DATA_DIR="$PWD/infrastructure/.runs/<run>/.terraform"
export TF_VAR_public_key=unused TF_VAR_name=unused
terraform -chdir="infrastructure/.runs/<run>" destroy
```

Run directories are private and ignored by Git. They retain Terraform state, logs, and screenshot evidence; password and SSH keys are removed at exit. HTTP is intentionally temporary and restricted, **not encrypted**: disposable credentials must never be reused. This is not a production deployment.

Local checks: `python3 -m unittest discover -s infrastructure -p 'test_*.py'`, `bash -n infrastructure/smoke.sh`, `terraform -chdir=infrastructure fmt -check`, and `npm test`.
