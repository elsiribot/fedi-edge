#!/usr/bin/env bash
# End-to-end USDT bridge test: USDT-only devimint federation (real cggmp21
# DKG) against a local anvil devnet, driven through fedi bridge APIs.
# Requires the nix dev shell (anvil, bitcoind). Takes several minutes.
set -euo pipefail

source scripts/common.sh

export PATH="${CARGO_BIN_DIR}:$PATH"

export RUST_BACKTRACE=0
export RUN_USDT_TESTS=1

# fedi packages
source scripts/test-common.sh ""
echo "Running in temporary directory $FM_TEST_DIR"

export FM_ADMIN_PASSWORD=p

echo "## Ensuring everything built"
cargo build --profile "${CARGO_PROFILE}" --all-targets
echo "## Running usdt bridge e2e test"
cargo nextest run -v --locked --cargo-profile "${CARGO_PROFILE}" \
	-E 'package(fedi-ffi) and test(test_usdt_bridge_end_to_end)' "$@"
echo "## Tests Passed"
