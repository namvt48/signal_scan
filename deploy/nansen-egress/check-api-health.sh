# Trả lỗi kiểm tra API/auth lên caller kể cả khi hàm được gọi trong nhánh `if !`.
check_api_health() {
  "${SSH[@]}" "$GATEWAY_HOST" 'set -eu; for api in signal_scan-api-1 signal_scan_b-api-1; do docker exec "$api" node -e "Promise.all([fetch(\"http://127.0.0.1:3001/api/health\"),fetch(\"http://127.0.0.1:3001/api/monitor/metrics\")]).then(async ([health,protectedResponse])=>{const body=await health.json();const doorsReady=body.doors===null||(Array.isArray(body.doors)&&body.doors.length===2);if(health.status!==200||!doorsReady||protectedResponse.status!==401||Object.hasOwn(process.env,\"AUTH_DISABLED\")||Object.hasOwn(process.env,\"VITE_AUTH_DISABLED\"))process.exit(1)}).catch(()=>process.exit(1))" || exit 1; done' || return 1
  "${SSH[@]}" "$GATEWAY_HOST" "set -eu; for web in signal_scan-web-1 signal_scan_b-web-1; do docker exec \"\$web\" sh -c 'test -z \"\${VITE_AUTH_DISABLED+x}\"' || exit 1; done"
}
