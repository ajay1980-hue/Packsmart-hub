#!/usr/bin/env bash
set -euo pipefail
mode=${1:?setup, run or cleanup required}
case "$mode" in setup|run|cleanup) ;; *) exit 2 ;; esac
id=${RUNVARA_QUALIFICATION_ID:?qualification ID required}
[[ "$id" =~ ^[0-9]+-[0-9]+$ ]] || exit 2
[[ "$id" == *-1 ]] || { echo 'HOLD: repeat qualification requires separate review and authority'; exit 1; }
prefix="runvara-qualification-$id"
root=$(pwd -P)
scratch="$root/.runvara-qualification/$id"
out="$scratch/evidence"
browser_out="$scratch/browser-evidence"
product="$prefix-product:local"
browser="$prefix-browser:local"
mkdir -p "$out"
owned_container() { [[ $(timeout 10s docker inspect -f '{{index .Config.Labels "runvara.qualification"}}' "$1" 2>/dev/null) == "$prefix" ]]; }
cleanup() {
  local failed=0 name containers images
  if [[ ! -f "$scratch/setup-started" ]]; then
    printf '{"cleanupExit":0,"notNeeded":true,"reason":"setup never began"}\n' > "$out/cleanup.json"
    return 0
  fi
  local container_names=("$prefix-absent" "$prefix-disabled" "$prefix-browser")
  local image_names=("$browser" "$product")
  if containers=$(timeout 10s docker container ls --all --format '{{.Names}}'); then
    for name in "${container_names[@]}"; do
      if ! grep -Fxq -- "$name" <<< "$containers"; then continue; fi
      if owned_container "$name"; then
        timeout 35s docker stop --time 30 "$name" >/dev/null || failed=1
        timeout 10s docker rm -f "$name" >/dev/null || failed=1
      else
        failed=1
      fi
    done
  else
    failed=1
  fi
  if images=$(timeout 10s docker image ls --all --format '{{.Repository}}:{{.Tag}}'); then
    for name in "${image_names[@]}"; do
      if ! grep -Fxq -- "$name" <<< "$images"; then continue; fi
      if [[ $(timeout 10s docker image inspect -f '{{index .Config.Labels "runvara.qualification"}}' "$name") == "$prefix" ]]; then
        timeout 10s docker image rm "$name" >/dev/null || failed=1
      else
        failed=1
      fi
    done
  else
    failed=1
  fi
  if containers=$(timeout 10s docker container ls --all --format '{{.Names}}'); then
    for name in "${container_names[@]}"; do
      if grep -Fxq -- "$name" <<< "$containers"; then failed=1; fi
    done
  else
    failed=1
  fi
  if images=$(timeout 10s docker image ls --all --format '{{.Repository}}:{{.Tag}}'); then
    for name in "${image_names[@]}"; do
      if grep -Fxq -- "$name" <<< "$images"; then failed=1; fi
    done
  else
    failed=1
  fi
  printf '{"cleanupExit":%s,"sharedBaseImagesPreserved":true}\n' "$failed" > "$out/cleanup.json"
  return "$failed"
}
if [[ "$mode" == cleanup ]]; then cleanup; exit; fi
node .github/ci/renewal/validate-inputs.mjs .
if [[ "$mode" == setup ]]; then
  # Setup is the only phase allowed registry/npm traffic in a future approved run.
  node_base=$(node -p "JSON.parse(require('fs').readFileSync('.github/ci/renewal/inputs.json')).nodeBase")
  browser_base=$(node -p "JSON.parse(require('fs').readFileSync('.github/ci/renewal/inputs.json')).browserBase")
  node_glibc_base=$(node -p "JSON.parse(require('fs').readFileSync('.github/ci/renewal/inputs.json')).nodeGlibcBase")
  [[ ! -f "$scratch/setup-started" ]] || { echo 'HOLD: setup already attempted'; exit 1; }
  touch "$scratch/setup-started"
  node .github/ci/renewal/prepare-context.mjs
  docker pull --platform linux/amd64 "$node_base"
  docker pull --platform linux/amd64 "$node_glibc_base"
  docker pull --platform linux/amd64 "$browser_base"
  docker build --platform linux/amd64 --pull=false --label "runvara.qualification=$prefix" -f "$scratch/recipe/Dockerfile" -t "$product" "$scratch/context"
  docker build --platform linux/amd64 --pull=false --label "runvara.qualification=$prefix" --build-arg "PRODUCT_IMAGE=$product" --build-arg "BROWSER_IMAGE=$browser_base" --build-arg "NODE_GLIBC_IMAGE=$node_glibc_base" -f "$scratch/context/.github/ci/renewal/Dockerfile.qualification" -t "$browser" "$scratch/context"
  docker image inspect "$node_base" "$node_glibc_base" "$browser_base" "$product" "$browser" --format '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"digests":{{json .RepoDigests}}}' > "$out/image-identities.jsonl"
  touch "$scratch/setup-complete"
  exit
fi

# Every app, browser and child test process below is inside network=none.
on_exit() {
  local status=$?
  trap - EXIT
  cleanup || status=1
  exit "$status"
}
trap 'on_exit' EXIT
trap 'exit 143' TERM INT
[[ -f "$scratch/setup-complete" && ! -f "$scratch/run-started" ]] || { echo 'HOLD: setup incomplete or run already attempted'; exit 1; }
touch "$scratch/run-started"
mkdir -m 0777 "$browser_out" # Browser output only. Runner records stay outside the mount.
common=(--pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=256 --memory=2g --cpus=2 --user=1000:1000 --label "runvara.qualification=$prefix" --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --tmpfs /app/saas/server/data:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700)
verify_boundary() {
  [[ $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$1") == none ]]
  [[ $(docker inspect -f '{{.HostConfig.Privileged}}' "$1") == false ]]
  [[ $(docker inspect -f '{{json .HostConfig.PortBindings}}' "$1") == '{}' || $(docker inspect -f '{{json .HostConfig.PortBindings}}' "$1") == null ]]
  docker inspect -f '{"id":{{json .Id}},"imageId":{{json .Image}},"network":{{json .HostConfig.NetworkMode}},"privileged":{{json .HostConfig.Privileged}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}' "$1" >> "$out/container-boundaries.jsonl"
}
for flag in absent disabled; do
  name="$prefix-$flag"
  envs=(-e NODE_ENV=production -e RUNVARA_STARTUP_MODE=quiet -e RUNVARA_QUIET_OWNER_WORKSPACE=enabled/v1 -e RUNVARA_QUIET_OWNER_LOGIN=enabled/v1 -e SAAS_STATE_FILE=/tmp/synthetic-state.json -e SESSION_SECRET=ci-synthetic-session-key-at-least-thirty-two-characters -e CREDENTIALS_KEY=ci-synthetic-encryption-key-at-least-thirty-two-characters)
  if [[ "$flag" == disabled ]]; then envs+=(-e RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL=disabled/v1); fi
  docker run -d --name "$name" "${common[@]}" "${envs[@]}" --mount "type=bind,src=$root/.github/ci/renewal,dst=/app/.github/ci/renewal,readonly" "$product" >/dev/null
  verify_boundary "$name"
  docker exec "$name" node .github/ci/renewal/network-check.mjs > "$out/$flag-network.log"
  docker exec "$name" node .github/ci/renewal/validate-inputs.mjs /app source-only > "$out/$flag-source.log"
  docker exec "$name" node .github/ci/renewal/disabled-probe.mjs > "$out/$flag-result.json"
  timeout 35s docker stop --time 30 "$name" >/dev/null
  [[ $(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$name") == 'false 0' ]]
  docker logs "$name" > "$scratch/$flag-runtime.log" 2>&1
  grep -q '"event":"server_shutdown_settled"' "$scratch/$flag-runtime.log"
  printf '{"stopped":true,"exitCode":0,"shutdownSettled":true}\n' > "$out/$flag-shutdown.json"
  docker rm "$name" >/dev/null
done
browser_seccomp="$root/.github/ci/renewal/chromium-seccomp.json"
printf '%s  %s\n' 0f26e298805cf214a731e7ab60bab43240a03325a3af7be07c64b0e67d7443c5 "$browser_seccomp" | sha256sum --check --status
docker run -d --name "$prefix-browser" "${common[@]}" --security-opt "seccomp=$browser_seccomp" --shm-size=512m -e HOME=/tmp --mount "type=bind,src=$browser_out,dst=/evidence" "$browser" >/dev/null
verify_boundary "$prefix-browser"
status=$(timeout 240s docker wait "$prefix-browser")
[[ "$status" == 0 ]]
[[ -f "$browser_out/complete.json" ]]
docker rm "$prefix-browser" >/dev/null
