#!/usr/bin/env python3
"""
Claude Code hook for MCP Playwright calls.
Prompts Claude to carefully verify playwright results against the original task.
"""

import json
import sys
from datetime import datetime

def main():
    try:
        
        try:
            hook_input = json.loads(sys.stdin.read())
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
            sys.exit(1)
        
        # Debug: Print raw input to understand structure
        print(f"DEBUG - Raw hook input type: {type(hook_input)}", file=sys.stderr)
        print(f"DEBUG - Raw hook input: {json.dumps(hook_input, indent=2)}", file=sys.stderr)
        
        # Extract information with fallback to old structure
        tool_name = hook_input.get('tool_name', hook_input.get('tool', {}).get('name', 'unknown'))
        tool_input = hook_input.get('tool_input', hook_input.get('tool', {}).get('parameters', {}))
        tool_response_raw = hook_input.get('tool_response', hook_input.get('result', {}))
        
        # Handle tool_response being a list vs dict
        if isinstance(tool_response_raw, list):
            # If it's a list, look for additionalContext in any of the items
            existing_context = ''
            for item in tool_response_raw:
                if isinstance(item, dict) and 'additionalContext' in item:
                    existing_context = item.get('additionalContext', '')
                    break
        else:
            # If it's a dict, get additionalContext directly
            existing_context = tool_response_raw.get('additionalContext', '') if isinstance(tool_response_raw, dict) else ''
        
        # Create our validation prompt
        validation_prompt = (
            "\n\n🔍 PLAYWRIGHT RESULT VALIDATION:\n\n"
            f"The {tool_name} action has completed.\n\n"
            "Please carefully analyze the output and think harder about:\n"
            "1) Did this action achieve the intended goal?\n"
            "2) Have we solved the current task completely?\n"
            "3) Do we need to add more tasks to the todo list based on what we discovered?\n"
            "4) Do we need to redo or revisit any past tasks?\n"
            "5) Are there any errors or unexpected outcomes that require attention?\n\n"
            "Think step-by-step, validate thoroughly, and consider the bigger picture before proceeding. Update your todo list if needed.\n\n"
        )
        
        # Combine existing context with our validation prompt
        if existing_context:
            combined_context = f"{existing_context}\n\n{validation_prompt}"
        else:
            combined_context = validation_prompt
        
        # Debug: Print extracted information
        print(f"DEBUG - Tool name: {tool_name}", file=sys.stderr)
        print(f"DEBUG - Tool response type: {type(tool_response_raw)}", file=sys.stderr)
        print(f"DEBUG - Existing context: {existing_context}", file=sys.stderr)
        print(f"DEBUG - Combined context: {combined_context}", file=sys.stderr)
        
        # Output JSON with correct PostToolUse structure
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": combined_context,
            }
        }
        
        print(json.dumps(output))
        
        sys.exit(2)
        
    except Exception as e:
        error_output = {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": f"⚠️  Playwright hook error: {str(e)} - Please verify the previous browser action completed successfully.",
            }
        }
        print(json.dumps(error_output))
        print(f"DEBUG - Hook error: {str(e)}", file=sys.stderr)
        sys.exit(2)

if __name__ == "__main__":
    main()