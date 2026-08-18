#!/usr/bin/env bash
# ============================================================
#  Tes endpoint self-host Krea 2 sebelum didaftarkan ke Pollinations
#  Pakai:
#    bash selfhost/test_endpoint.sh https://xxx.trycloudflare.com
# ============================================================
set -u
BASE="${1%/}"
if [ -z "$BASE" ]; then
  echo "❌ Pakai: bash selfhost/test_endpoint.sh https://xxx.trycloudflare.com"
  exit 1
fi

OUT="$TEMP/rekty_ep_test"
mkdir -p "$OUT"
PASS=0; FAIL=0

say()  { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }

say "1) /v1/models — cek id model yang dijawab endpoint"
MODELS=$(curl -s -m 20 "$BASE/v1/models")
if [ -n "$MODELS" ] && [ "$MODELS" != "null" ]; then
  echo "$MODELS" | head -c 500; echo
  IDS=$(echo "$MODELS" | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//' | head -5)
  if [ -n "$IDS" ]; then
    echo "  ID model tersedia:"; echo "$IDS" | sed 's/^/    - /'
    ok "/v1/models menjawab dengan model id"
  else
    echo "$MODELS" | head -c 300; echo
    bad "/v1/models tidak memuat id model (cek gateway)"
  fi
else
  bad "/v1/models tidak menjawab (endpoint mati / salah URL)"
fi

say "2) Generate tes 832x1536 (prompt sederhana)"
RESP=$(curl -s -m 120 -X POST "$BASE/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d '{"model":"rekty1988/anjany","prompt":"a cute cat with blue eyes, studio lighting","size":"832x1536","steps":8,"cfg_scale":1.0}')
echo "$RESP" | head -c 200; echo
B64=$(echo "$RESP" | python -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print((d.get('data') or [{}])[0].get('b64_json', ''))
except Exception:
    print('')
" 2>/dev/null)
if [ -n "$B64" ]; then
  echo "$B64" | python -c "
import base64, sys
raw = base64.b64decode(sys.stdin.read())
open(r'$OUT/test.png', 'wb').write(raw)
print(f'  ukuran file: {len(raw):,} byte')
" 
  MAGIC=$(head -c 8 "$OUT/test.png" | od -An -tx1 | tr -d ' \n')
  case "$MAGIC" in
    89504e47*) ok "Gambar valid PNG ($MAGIC)" ;;
    ffd8ff*)   ok "Gambar valid JPEG ($MAGIC)" ;;
    *)         bad "File bukan gambar ($MAGIC)" ;;
  esac
  [ -s "$OUT/test.png" ] && cp "$OUT/test.png" "$OUT/test-$(date +%H%M%S).png"
else
  bad "Respons tidak memuat b64_json — cek log gateway"
fi

say "HASIL"
echo "  Lulus: $PASS | Gagal: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 Endpoint SIAP didaftarkan ke Pollinations (lihat selfhost/REGISTER_POLLINATIONS.md)"
else
  echo "  ⚠️ Ada yang gagal — perbaiki dulu sebelum daftar ke Pollinations"
fi
echo "  Gambar tes tersimpan di: $OUT/"
