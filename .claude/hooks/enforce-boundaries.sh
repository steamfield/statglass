#!/bin/bash
# PreToolUse hook: enforce architecture boundaries on file writes.
# Denies violations that can't be silently fixed (need design decisions).
#
# Boundaries (biome.json's noRestrictedImports overrides enforce the same set;
# this catches them at write time):
# 1. packages/core/src/ is shared with the iPhone app: no React, React Native,
#    Expo, Tauri, @steamfield/ui, desktop adapters or the app layer (~/)
# 2. src/app/widgets/ is render-only: no transport, stores, router, or Tauri APIs
# 3. apps/mobile/ never imports react-dom, Tauri, the desktop app or desktop
#    adapters, and its relative imports never leave apps/mobile/
# 4. The desktop app (src/app/, src/desktop-transport/, src/main.tsx) never
#    imports react-native or Expo

input=$(cat)

deny() {
    jq -n --arg reason "$1" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
}

tool_name=$(echo "$input" | jq -r '.tool_name // empty')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

[[ -z "$file_path" ]] && exit 0
# Payloads carry absolute paths; accept a repo-relative one too.
[[ "$file_path" == /* ]] || file_path="/$file_path"

# Extract the text being written
if [[ "$tool_name" == "Edit" ]]; then
    text=$(echo "$input" | jq -r '.tool_input.new_string // empty')
elif [[ "$tool_name" == "Write" ]]; then
    text=$(echo "$input" | jq -r '.tool_input.content // empty')
elif [[ "$tool_name" == "MultiEdit" ]]; then
    text=$(echo "$input" | jq -r '[.tool_input.edits[]?.new_string // empty] | join("\n")')
else
    exit 0
fi

[[ -z "$text" ]] && exit 0

mobile_rel=""

# --- Rule 1: packages/core/src/ has no framework, platform or app imports ---
if [[ "$file_path" =~ /packages/core/src/.*\.(ts|tsx)$ && "$file_path" != */packages/core/src/generated/* ]]; then
    if printf '%s' "$text" | grep -qE -e "from[[:space:]]+[\"'](~|react|react-dom|react-native|react-native-[^\"'/]+|zustand/react|@tanstack/react-query|expo|expo-[^\"'/]+|@expo|@tauri-apps|@steamfield/ui|@desktop)([\"'/])"; then
        deny "BLOCKED: Architecture boundary violation.

packages/core/src/ (@statglass/core) is shared by the desktop and the iPhone
app. It must not import React, React Native, Expo, @tauri-apps/*,
@steamfield/ui, desktop adapters (@desktop/*) or anything from ~/ (src/app/).

Options:
  - Keep the pure logic in @core/ and put the hook/component in each app
  - Pass platform values into core functions as measurable parameters
  - See .claude/rules/shared-packages.md (fork instead of flagging)"
    fi
fi

# --- Rule 2: src/app/widgets/ is render-only ---
if [[ "$file_path" =~ /src/app/widgets/.*\.(ts|tsx)$ ]]; then
    if printf '%s' "$text" | grep -qE -e "from[[:space:]]+[\"'](@core/transport|@tauri-apps/|react-router|zustand|@tanstack/react-query|~/stores/|~/routes/|@desktop/)"; then
        deny "BLOCKED: Architecture boundary violation.

src/app/widgets/ components are render-only. They take data and callbacks as
props so the same component renders in the popover, overview cards, board
windows and composer preview, and its prop contract matches the v3 WidgetKit
feed. They must not import @core/transport, stores, react-router, TanStack
Query, @tauri-apps/* or the desktop adapters (@desktop/*).

Options:
  - Subscribe/fetch in the route or a hook under src/app/hooks/, pass values down
  - Take a callback prop (onOpen, onSelect) instead of navigating or invoking"
    fi
fi

# --- Rule 3: apps/mobile/ stays out of the desktop app ---
if [[ "$file_path" =~ /apps/mobile/(.*)\.(ts|tsx|js|jsx|mjs|cjs)$ ]]; then
    mobile_rel="${BASH_REMATCH[1]}"
fi
if [[ -n "$mobile_rel" && ! "$mobile_rel" =~ ^(ios|node_modules|\.expo)/ ]]; then
    mobile_reason=""
    if printf '%s' "$text" | grep -qE -e "from[[:space:]]+[\"'](react-dom|@tauri-apps|@desktop|~)([\"'/])"; then
        mobile_reason="It imports react-dom, @tauri-apps/*, a desktop adapter (@desktop/*) or the desktop app (~/)."
    else
        # Directory depth below apps/mobile/; a relative import that climbs
        # further leaves the app (into src/app/, packages/ or anywhere else).
        slashes="${mobile_rel//[^\/]/}"
        depth=${#slashes}
        while IFS= read -r spec; do
            ups=$(printf '%s' "$spec" | grep -oE '\.\./' | wc -l | tr -d ' ')
            if (( ups > depth )); then
                mobile_reason="Its relative import \"$spec\" leaves apps/mobile/."
                break
            fi
        done < <(printf '%s' "$text" | grep -oE -e "from[[:space:]]+[\"'](\.\./)+[^\"']*" | sed -E "s/^from[[:space:]]+[\"']//")
    fi
    if [[ -n "$mobile_reason" ]]; then
        deny "BLOCKED: Architecture boundary violation.

$mobile_reason
apps/mobile renders with React Native and talks to Rust through the
statglass-native module. It never imports react-dom, @tauri-apps/*,
@desktop/* or the desktop app, and shared code comes from packages/core
through the @core/* alias.

Options:
  - Use the shared logic through @core/* (move it there with its second consumer)
  - Write the phone's own renderer or hook under apps/mobile/src/
  - See .claude/rules/mobile/expo.md and .claude/rules/shared-packages.md"
    fi
fi

# --- Rule 4: the desktop app never imports React Native or Expo ---
if [[ ( "$file_path" =~ /src/(app|desktop-transport)/.*\.(ts|tsx)$ || "$file_path" == */src/main.tsx ) \
   && "$file_path" != */apps/mobile/* ]]; then
    if printf '%s' "$text" | grep -qE -e "from[[:space:]]+[\"'](react-native|react-native-[^\"'/]+|expo|expo-[^\"'/]+|@expo)([\"'/])"; then
        deny "BLOCKED: Architecture boundary violation.

The desktop app renders with React DOM inside Tauri webviews. It must not
import react-native, expo, expo-* or @expo/*; those belong to apps/mobile.

Options:
  - Use the desktop's own component or a DOM/Tauri equivalent
  - Share logic through packages/core (@core/*), never a native package"
    fi
fi

exit 0
