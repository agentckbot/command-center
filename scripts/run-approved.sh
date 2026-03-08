#!/usr/bin/env bash
set -euo pipefail

# run-approved.sh — Find approved tasks in TASKS.md, spawn Claude Code to implement them
#
# Usage:
#   ./scripts/run-approved.sh              # spawn for all approved tasks
#   ./scripts/run-approved.sh --dry-run    # just show what would be spawned
#   ./scripts/run-approved.sh --use-generic # (compat flag, ignored)

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_FILE="$PROJECT_DIR/TASKS.md"
PROJECT_NAME="$(basename "$PROJECT_DIR")"

DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=true;  shift ;;
    --use-generic)  shift ;;  # compat, ignored
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$TASKS_FILE" ]]; then
  echo "Error: TASKS.md not found at $TASKS_FILE" >&2
  exit 1
fi

# Extract bullet items under ## ✅ Approved (or ## Approved)
extract_approved_tasks() {
  local in_approved=false
  while IFS= read -r line; do
    if [[ "$line" =~ ^##[[:space:]]+(✅[[:space:]]+)?Approved ]]; then
      in_approved=true
      continue
    fi
    if [[ "$line" =~ ^##[[:space:]] ]] && $in_approved; then
      break
    fi
    if $in_approved && [[ "$line" =~ ^-[[:space:]]\[[[:space:]]\][[:space:]]+(.+) ]]; then
      echo "${BASH_REMATCH[1]}"
    fi
  done < "$TASKS_FILE"
}

# Move task from Approved to In Progress
move_to_in_progress() {
  local task_text="$1"
  local tmp
  tmp=$(mktemp)

  local in_approved=false
  local in_progress_found=false
  local task_line=""
  local task_removed=false

  # First pass: remove from Approved, capture the line
  while IFS= read -r line; do
    if [[ "$line" =~ ^##[[:space:]]+(✅[[:space:]]+)?Approved ]]; then
      in_approved=true
      echo "$line" >> "$tmp"
      continue
    fi
    if [[ "$line" =~ ^##[[:space:]] ]] && $in_approved; then
      in_approved=false
    fi
    if $in_approved && ! $task_removed && [[ "$line" == *"$task_text"* ]]; then
      task_line="$line"
      task_removed=true
      continue
    fi
    echo "$line" >> "$tmp"
  done < "$TASKS_FILE"

  if [[ -z "$task_line" ]]; then
    rm -f "$tmp"
    return
  fi

  # Second pass: insert into In Progress
  local tmp2
  tmp2=$(mktemp)
  local inserted=false
  while IFS= read -r line; do
    echo "$line" >> "$tmp2"
    if ! $inserted && [[ "$line" =~ ^##[[:space:]]+(🟡[[:space:]]+)?In[[:space:]]+Progress ]]; then
      echo "$task_line" >> "$tmp2"
      inserted=true
    fi
  done < "$tmp"

  mv -f "$tmp2" "$TASKS_FILE"
  rm -f "$tmp"
}

# Main
tasks=$(extract_approved_tasks)

if [[ -z "$tasks" ]]; then
  echo "No approved tasks found in TASKS.md"
  exit 0
fi

echo "Approved tasks:"
while IFS= read -r task; do
  echo "  • $task"
done <<< "$tasks"
echo ""

if $DRY_RUN; then
  echo "[DRY RUN] Would spawn Claude Code for the above tasks"
  exit 0
fi

# Build combined prompt from all approved tasks
task_list=""
while IFS= read -r task; do
  task_list+="- $task"$'\n'
  move_to_in_progress "$task"
done <<< "$tasks"

echo "Moved tasks to In Progress"
echo "Spawning Claude Code..."

# Read PROJECT.md for context
project_context=""
if [[ -f "$PROJECT_DIR/PROJECT.md" ]]; then
  project_context=$(cat "$PROJECT_DIR/PROJECT.md")
fi

# Spawn Claude Code
claude -p "You are working on the project '$PROJECT_NAME' at $PROJECT_DIR.

## Project Context
$project_context

## Tasks to Implement
$task_list

Read the existing codebase first to understand the project structure. Implement all the tasks listed above. Write clean, tested code. Commit your changes when done.

When completely finished, run: openclaw system event --text \"Done: Implemented tasks for $PROJECT_NAME\" --mode now" --dangerously-skip-permissions &

CODER_PID=$!
echo "Claude Code spawned (PID: $CODER_PID)"

# Wait for completion
if wait "$CODER_PID"; then
  echo "Claude Code completed successfully"
  
  # Commit and push
  cd "$PROJECT_DIR"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "Implement approved tasks" --no-verify
    git push 2>/dev/null || echo "Push failed (non-fatal)"
  fi
  
  openclaw system event --text "✅ Implementation complete: $PROJECT_NAME" --mode now 2>/dev/null || true
else
  echo "Claude Code failed"
  openclaw system event --text "❌ Implementation failed: $PROJECT_NAME — needs manual review" --mode now 2>/dev/null || true
fi