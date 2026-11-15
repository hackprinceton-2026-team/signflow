#!/bin/sh
# Copy the recognizer's two live models into ml/models/ from the pinned commit of Umar's branch
# keyword-model-v5. They are not committed to main (binaries; derived from WLASL, which is licensed
# for academic, non-commercial use only). Each file is checked against its sha256 before it is used.
#
#   ml/scripts/fetch_models.sh        (from anywhere inside the repo)
set -eu
COMMIT=d911607869bd3d5ac8051093b8c2f63bc384dd1f
ROOT=$(git rev-parse --show-toplevel)
DEST="$ROOT/ml/models"

if ! git -C "$ROOT" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  echo "fetching branch keyword-model-v5 (pinned commit ${COMMIT%"${COMMIT#???????}"}) ..."
  git -C "$ROOT" fetch origin keyword-model-v5
fi
mkdir -p "$DEST"

fetch() {
  name=$1 sha=$2
  git -C "$ROOT" show "$COMMIT:models/$name" > "$DEST/$name.part"
  got=$(shasum -a 256 "$DEST/$name.part" | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then
    rm -f "$DEST/$name.part"
    echo "sha256 mismatch for models/$name: got $got, expected $sha" >&2
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
  echo "ok  ml/models/$name  sha256 $sha"
}

fetch sign_model.joblib    a638badd926c97c1418c26101d1e4a9b58eb2ad9aec3490fe4a1ac2fd8be01bf   # 14-sign demo model
fetch keyword_model.joblib 778e74f3cc53ce1978cd6704607e8c1e748b90318d068ef327daa306871a4562   # 116-sign keyword model
