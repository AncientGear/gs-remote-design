#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash infrastructure/smoke.sh [--help]'
  echo 'Creates paid EC2 resources: ahau-2026 / us-east-1 / 189.215.51.112/32.'
  echo 'Installs latest stable gentle-shell, tests canvas in Chromium, then runs terraform destroy.'
  exit 0
fi
if (( $# )); then echo "Unknown argument: $1" >&2; exit 2; fi
cd "$(dirname "$0")"
umask 077
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true
# Do not let inherited LocalStack/static credentials override the selected profile.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export AWS_PROFILE=ahau-2026 AWS_REGION=us-east-1
for tool in terraform aws ssh scp ssh-keygen node npm curl tar; do command -v "$tool" >/dev/null; done
[[ $(curl -fsS --max-time 15 https://checkip.amazonaws.com) == 189.215.51.112 ]] || { echo 'Egress IP mismatch' >&2; exit 1; }
aws sts get-caller-identity --profile ahau-2026 --region us-east-1 --query Account --output text >/dev/null
mkdir -p .runs
run=$(mktemp -d "$PWD/.runs/test-XXXXXXXX")
echo "Evidence and recovery state: $run"
cp main.tf "$run/"
export TF_DATA_DIR="$run/.terraform"
ssh-keygen -q -t ed25519 -N '' -f "$run/key"
export TF_VAR_public_key="$(<"$run/key.pub")" TF_VAR_name="gs-smoke-$(basename "$run")"
managed=0
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if (( managed )); then
    if [[ -n ${ip:-} ]]; then
      ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cat ~/smoke/rpc.log' >"$run/rpc.log" 2>&1 || true
    fi
    if terraform -chdir="$run" destroy -auto-approve -input=false -no-color >"$run/destroy.log" 2>&1; then
      terraform -chdir="$run" state list >"$run/remaining-state.txt"
      if [[ -s "$run/remaining-state.txt" ]]; then result=1; echo 'ERROR: managed state remains' >&2;
      else echo 'Cleanup confirmed: Terraform manages zero resources'; fi
    else
      echo "ERROR: destroy failed; retain $run and run terraform destroy there. See destroy.log" >&2
      result=1
    fi
  fi
  rm -f "$run/password" "$run/key" "$run/key.pub"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
terraform -chdir="$run" init -input=false -no-color >"$run/init.log" 2>&1
terraform -chdir="$run" validate -no-color
npm install --prefix "$run" --no-audit --no-fund playwright >"$run/browser-install.log" 2>&1
PLAYWRIGHT_BROWSERS_PATH="$run/browsers" "$run/node_modules/.bin/playwright" install chromium >>"$run/browser-install.log" 2>&1
cp browser.mjs "$run/"
(cd "$run"; PLAYWRIGHT_BROWSERS_PATH="$run/browsers" node --input-type=module -e 'import { chromium } from "playwright"; const b = await chromium.launch(); await b.close();')
terraform -chdir="$run" plan -input=false -out=plan -no-color >"$run/plan.log" 2>&1
managed=1
terraform -chdir="$run" apply -input=false -no-color plan >"$run/apply.log" 2>&1
ip=$(terraform -chdir="$run" output -raw public_ip)
terraform -chdir="$run" output -json >"$run/outputs.json"
ssh_opts=(-i "$run/key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$run/known_hosts" -o ConnectTimeout=5 -o BatchMode=yes)
ready=0
for ((i=0;i<60;i++)); do
  if ssh "${ssh_opts[@]}" "ubuntu@$ip" true 2>/dev/null; then ready=1; break; fi
  sleep 5
done
(( ready )) || { echo 'SSH readiness timeout' >&2; exit 1; }
# Official Node binary: verify SHA-256 before executing. Pin latest compatible LTS at run time.
ssh "${ssh_opts[@]}" "ubuntu@$ip" 'bash -s' >"$run/install.log" 2>&1 <<'REMOTE'
set -euo pipefail
sudo cloud-init status --wait
sudo apt-get update -qq
sudo apt-get install -y -qq curl git xz-utils
mkdir -p ~/smoke; cd ~/smoke
curl -fsS https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
archive=$(awk '$2 ~ /linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
[[ -n "$archive" ]]
curl -fsS "https://nodejs.org/dist/latest-v22.x/$archive" -o "$archive"
grep " $archive$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf "$archive" -C /usr/local --strip-components=1
version=$(npm view gentle-pi dist-tags.latest)
sudo npm install -g "gentle-pi@$version" @earendil-works/pi-coding-agent
printf 'Installed stable gentle-pi=%s\n' "$version"
REMOTE
# Upload exactly the local extension under test, excluding state, credentials and dependencies.
tar -C .. -czf "$run/repo.tar.gz" src extensions package.json README.md
scp "${ssh_opts[@]}" "$run/repo.tar.gz" remote.mjs "ubuntu@$ip:/home/ubuntu/smoke/" >/dev/null
ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cd ~/smoke; mkdir repo; tar -xzf repo.tar.gz -C repo; gentle-shell --home /home/ubuntu/smoke/agent install /home/ubuntu/smoke/repo' >>"$run/install.log" 2>&1
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" >"$run/password"
ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cd ~/smoke; umask 077; cat >password; nohup sh -c "node --experimental-strip-types remote.mjs <password; rm -f password" >rpc.log 2>&1 </dev/null &' <"$run/password"
ready=0
for ((i=0;i<60;i++)); do
  if curl -fsS --max-time 3 "http://$ip:30000/" >"$run/login.html"; then ready=1; break; fi
  sleep 3
done
(( ready )) || { ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cat ~/smoke/rpc.log'; echo 'Relay readiness timeout' >&2; exit 1; }
PLAYWRIGHT_BROWSERS_PATH="$run/browsers" node "$run/browser.mjs" "http://$ip:30000/" "$run/password" "$run"
ssh "${ssh_opts[@]}" "ubuntu@$ip" 'cat ~/smoke/rpc.log' >"$run/rpc.log"
