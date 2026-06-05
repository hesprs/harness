#!/usr/bin/env bash

HARNESS_DIR="$HOME/.omp/agent"

ln -s "$PWD/skills" "$HARNESS_DIR/skills"
ln -s "$PWD/APPEND_SYSTEM.md" "$HARNESS_DIR/APPEND_SYSTEM.md"
ln -s "$PWD/agents" "$HARNESS_DIR/agents"
