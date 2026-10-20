#!/usr/bin/env bash
set -euo pipefail

TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TEST_DIR/check-api-health.sh"

SSH=(fake_ssh)
GATEWAY_HOST=unused
calls=0
fail_first=1
fake_ssh() {
  calls=$((calls + 1))
  if [[ "$fail_first" == 1 && "$calls" == 1 ]]; then return 7; fi
  return 0
}

# Hồi quy: SSH kiểm tra API lỗi nhưng SSH kiểm tra web thành công; cả hàm vẫn phải lỗi.
if ! check_api_health; then
  printf 'API SSH failure propagated through if !\n'
else
  printf 'API health failure was masked by the web check\n' >&2
  exit 1
fi
[[ "$calls" == 1 ]] || { printf 'expected early return after failed API SSH; got %s calls\n' "$calls" >&2; exit 1; }

fail_first=0
calls=0
check_api_health
[[ "$calls" == 2 ]] || { printf 'expected both SSH checks on success; got %s calls\n' "$calls" >&2; exit 1; }
printf 'check_api_health failure propagation passed\n'
