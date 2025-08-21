#!/usr/bin/env python3
"""
MCP Server Configuration Validator using DSPy
Single-file implementation with clean class organization

This is a refactored version of validate_mcp_configs.py using DSPy for AI operations.
Key improvements:
- DSPy integration for structured AI prompting
- Clean class organization (Config, Debug, AIEngine, Database, GitHub, MCPValidator)  
- Simplified codebase (~400 lines vs 2000+ lines)
- Type-safe AI signatures
- Better error handling and debug output

Requirements:
  pip install dspy-ai requests

Usage:
  # Basic usage (make sure Ollama is running with qwen3:30b)
  ollama run qwen3:30b
  source .venv/bin/activate && python scripts/validate_mcp_configs_dspy.py
  
  # Debug mode to see 6-step pipeline in action
  source .venv/bin/activate && python scripts/validate_mcp_configs_dspy.py --debug --limit 3
  
  # Force reprocess all servers
  source .venv/bin/activate && python scripts/validate_mcp_configs_dspy.py --force
  
  # Use different model (must be available in Ollama)
  ollama run llama3.2:3b
  source .venv/bin/activate && python scripts/validate_mcp_configs_dspy.py --model llama3.2:3b

Environment Variables:
  GITHUB_TOKEN - GitHub API token for higher rate limits
  DEBUG - Set to "true" to enable debug mode
"""

import dspy
import json
import sqlite3
import os
import re
import time
import requests
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from datetime import datetime

# ============================================================================
# CONFIGURATION
# ============================================================================

@dataclass
class Config:
    """Central configuration"""
    db_path: str = "database/servers.db"
    model: str = "qwen3:30b"
    ollama_base: str = "http://localhost:11434"
    github_token: Optional[str] = field(default_factory=lambda: os.environ.get("GITHUB_TOKEN"))
    debug: bool = field(default_factory=lambda: os.environ.get("DEBUG") == "true")
    force: bool = False
    limit: Optional[int] = None

# ============================================================================
# DEBUG UTILITIES
# ============================================================================

class Debug:
    """Simple debug utilities"""
    def __init__(self, enabled: bool = False):
        self.enabled = enabled
    
    def log(self, message: str, data: Any = None):
        if self.enabled:
            print(f"  🔍 Debug: {message}")
            if data:
                print(f"    Data: {data}")

# ============================================================================
# DSPY AI MODULES - Multi-Step Pipeline
# ============================================================================

class DocumentRelevanceAnalyzer(dspy.Signature):
    """Identify which documentation sections contain installation/setup info"""
    documentation = dspy.InputField(desc="Full documentation content")
    
    relevant_sections = dspy.OutputField(desc="JSON array of relevant sections with type (installation/config/docker/etc)")
    has_mcp_support = dspy.OutputField(desc="YES/NO/MAYBE - whether this is actually an MCP server")

class InstallationCommandExtractor(dspy.Signature):
    """Extract raw installation commands from relevant sections"""
    relevant_sections = dspy.InputField(desc="Relevant documentation sections")
    
    raw_commands = dspy.OutputField(desc="JSON array of raw commands found (docker run, npm install, etc)")
    config_examples = dspy.OutputField(desc="JSON array of configuration examples found")

class MethodStructurer(dspy.Signature):
    """Structure raw commands into proper installation methods"""
    raw_commands = dspy.InputField(desc="Raw installation commands")
    config_examples = dspy.InputField(desc="Configuration examples")
    
    structured_methods = dspy.OutputField(desc="JSON array with structured method objects (name, install, startup, runtime, etc)")


class MethodValidator(dspy.Signature):
    """Validate if method requires ZERO installation for MCP deployment
    
    ONLY VALID (score 10) methods:
    - npx -y @package-name (auto-installs from npm registry)
    - uvx package-name (auto-installs from PyPI registry)  
    - docker run image:tag (pulls and runs container)
    - https://api.example.com/mcp (remote HTTP server)
    
    INVALID (score 1) methods that require installation:
    - npm install + node script (requires npm install step)
    - pip install + python script (requires pip install step)
    - ./local-binary or local scripts (requires download/build)
    - Multi-step setup processes
    - Any command requiring prior software installation
    """
    method = dspy.InputField(desc="Installation method to validate")
    
    is_valid = dspy.OutputField(desc="YES only if method requires ZERO installation")
    issues = dspy.OutputField(desc="Why method requires installation if invalid")
    deployment_ease = dspy.OutputField(desc="10 if zero-install, 1 if requires installation")

class MethodRanker(dspy.Signature):
    """Classify methods by zero-installation requirement
    
    We ONLY accept perfect methods that require absolutely no installation.
    
    Categories:
    - perfect_methods: Methods that work immediately (npx -y, uvx, docker run, https://)
    - acceptable_methods: EMPTY (we reject all methods requiring any setup)
    - complex_methods: Everything else (all rejected)
    """
    methods = dspy.InputField(desc="Array of methods with deployment scores")
    
    perfect_methods = dspy.OutputField(desc="Methods with score 10 requiring zero installation")
    acceptable_methods = dspy.OutputField(desc="Always empty - we reject all non-perfect")
    complex_methods = dspy.OutputField(desc="Methods with score < 10 that require installation")

class ParameterExtractor(dspy.Signature):
    """Extract required parameters and environment variables from documentation"""
    documentation = dspy.InputField(desc="Documentation content about the MCP server")
    method = dspy.InputField(desc="Installation method/command being analyzed")
    
    parameters = dspy.OutputField(desc="JSON array of required command-line parameters with descriptions")
    env_vars = dspy.OutputField(desc="JSON object mapping environment variable names to their descriptions")

class URLExtractor(dspy.Signature):
    """Extract API endpoints and service URLs from documentation for remote MCP servers
    
    Look for:
    - API endpoints (https://api.example.com/mcp)
    - Service URLs mentioned in setup instructions
    - Connection strings or endpoint configurations
    - Remote server addresses
    """
    documentation = dspy.InputField(desc="Documentation content to search for URLs")
    server_name = dspy.InputField(desc="Name of the MCP server for context")
    
    urls = dspy.OutputField(desc="JSON array of objects with url, type (api/endpoint/service), and description")
    has_remote_option = dspy.OutputField(desc="YES/NO - whether this server can be used as a remote service")

class AIEngine:
    """Multi-step DSPy pipeline for MCP validation"""
    
    def __init__(self, config: Config):
        self.config = config
        self.debug = Debug(config.debug)
        
        # Initialize DSPy with Ollama using correct syntax
        self.lm = dspy.LM(
            model=f"ollama_chat/{config.model}",
            api_base=config.ollama_base,
            api_key=""
        )
        dspy.configure(lm=self.lm)
        
        # Create pipeline modules
        self.doc_analyzer = dspy.ChainOfThought(DocumentRelevanceAnalyzer)
        self.cmd_extractor = dspy.ChainOfThought(InstallationCommandExtractor)
        self.method_structurer = dspy.ChainOfThought(MethodStructurer)
        self.parameter_extractor = dspy.ChainOfThought(ParameterExtractor)
        self.url_extractor = dspy.ChainOfThought(URLExtractor)
        self.method_validator = dspy.ChainOfThought(MethodValidator)
        self.method_ranker = dspy.ChainOfThought(MethodRanker)
    
    def extract_methods(self, docs: Dict[str, str], server_data: Dict) -> List[Dict]:
        """Multi-step extraction pipeline with fast path for JSON configs"""
        combined_docs = self._combine_documentation(docs)
        
        try:
            # Fast path: Check for ready-to-use MCP JSON configs
            self.debug.log("Fast path: Checking for MCP JSON configurations...")
            json_configs = self.parse_mcp_json_configs(combined_docs)
            if json_configs:
                self.debug.log(f"Found {len(json_configs)} valid JSON configs, skipping AI pipeline")
                if self.debug.enabled:
                    for i, config in enumerate(json_configs, 1):
                        self.debug.log(f"  JSON Config {i}:")
                        self.debug.log(f"    Name: {config.get('name', 'N/A')}")
                        self.debug.log(f"    Command: {config.get('command', 'N/A')}")
                        self.debug.log(f"    Type: {config.get('type', 'N/A')}")
                        self.debug.log(f"    Score: {config.get('deployment_score', 'N/A')}")
                return json_configs
            
            # Step 1: Analyze document relevance
            self.debug.log("Step 1: Analyzing document relevance...")
            doc_analysis = self.doc_analyzer(documentation=combined_docs[:50000])
            
            if doc_analysis.has_mcp_support == "NO":
                self.debug.log("Not an MCP server, skipping")
                return []
            
            self.debug.log(f"MCP support: {doc_analysis.has_mcp_support}")
            
            # Step 2: Extract raw commands
            self.debug.log("Step 2: Extracting installation commands...")
            raw_extraction = self.cmd_extractor(
                relevant_sections=doc_analysis.relevant_sections
            )
            
            # Parse raw commands
            raw_commands = json.loads(raw_extraction.raw_commands) if isinstance(raw_extraction.raw_commands, str) else raw_extraction.raw_commands
            config_examples = json.loads(raw_extraction.config_examples) if isinstance(raw_extraction.config_examples, str) else raw_extraction.config_examples
            
            self.debug.log(f"Found {len(raw_commands)} raw commands and {len(config_examples)} config examples")
            
            if not raw_commands and not config_examples:
                self.debug.log("No installation commands found")
                return []
            
            # Step 3: Structure methods
            self.debug.log("Step 3: Structuring methods...")
            structured = self.method_structurer(
                raw_commands=json.dumps(raw_commands),
                config_examples=json.dumps(config_examples)
            )
            
            methods = json.loads(structured.structured_methods) if isinstance(structured.structured_methods, str) else structured.structured_methods
            self.debug.log(f"Structured into {len(methods)} methods")
            
            if not methods:
                return []
            
            # Step 4: Extract parameters and env vars for each method using AI
            self.debug.log("Step 4: Extracting parameters and environment variables...")
            for i, method in enumerate(methods):
                try:
                    param_result = self.parameter_extractor(
                        method=json.dumps(method),
                        documentation=combined_docs[:20000]
                    )
                    method['env_vars'] = json.loads(param_result.env_vars) if isinstance(param_result.env_vars, str) else param_result.env_vars
                    method['parameters'] = json.loads(param_result.parameters) if isinstance(param_result.parameters, str) else param_result.parameters
                    self.debug.log(f"  Method {i+1}: {len(method.get('env_vars', {}))} env vars, {len(method.get('parameters', []))} parameters")
                except Exception as e:
                    self.debug.log(f"  Method {i+1}: Failed to extract parameters: {e}")
                    method['env_vars'] = {}
                    method['parameters'] = []
            
            # Step 4.5: Extract URLs for remote services
            self.debug.log("Step 4.5: Extracting remote service URLs...")
            try:
                url_result = self.url_extractor(
                    documentation=combined_docs[:30000],
                    server_name=server_data.get('server_name', 'unknown')
                )
                
                extracted_urls = json.loads(url_result.urls) if isinstance(url_result.urls, str) else url_result.urls
                
                if extracted_urls and url_result.has_remote_option == "YES":
                    self.debug.log(f"  Found {len(extracted_urls)} potential remote URLs")
                    
                    # Add remote methods for each valid URL
                    for url_info in extracted_urls:
                        if isinstance(url_info, dict) and 'url' in url_info:
                            url = url_info['url']
                            if url.startswith('http://') or url.startswith('https://'):
                                remote_method = {
                                    'name': f"{server_data.get('server_name', 'unknown')}-remote",
                                    'command': url,
                                    'type': 'http',
                                    'registry': 'remote',
                                    'package': url,
                                    'runtime': 'http',
                                    'deployment_score': 10,
                                    'env_vars': {},
                                    'parameters': [],
                                    'description': url_info.get('description', 'Remote API endpoint')
                                }
                                
                                # Look for auth requirements in the URL description
                                desc = url_info.get('description', '').lower()
                                if any(keyword in desc for keyword in ['auth', 'token', 'key', 'bearer']):
                                    # Extract likely environment variable names
                                    server_name_upper = server_data.get('server_name', 'unknown').upper().replace('-', '_').replace('/', '_')
                                    if 'github' in server_name_upper.lower():
                                        remote_method['env_vars']['GITHUB_PERSONAL_ACCESS_TOKEN'] = 'GitHub Personal Access Token for API authentication'
                                    elif 'api' in desc:
                                        remote_method['env_vars'][f'{server_name_upper}_API_TOKEN'] = f'API token for {server_data.get("server_name", "unknown")} authentication'
                                
                                methods.append(remote_method)
                                self.debug.log(f"  Added remote method: {url}")
                else:
                    self.debug.log("  No remote service URLs found")
            except Exception as e:
                self.debug.log(f"  URL extraction failed: {e}")
            
            # Step 4.7: Add known remote methods for recognized servers
            self.debug.log("Step 4.7: Checking for known remote services...")
            methods = self._add_known_remote_methods(methods, server_data)
            
            # Step 5: Validate each method (strict zero-installation only)
            self.debug.log("Step 5: Validating methods...")
            validated_methods = []
            for i, method in enumerate(methods):
                try:
                    validation = self.method_validator(method=json.dumps(method))
                    if validation.is_valid == "YES":
                        score = int(validation.deployment_ease) if validation.deployment_ease.isdigit() else 1
                        method['deployment_score'] = score
                        
                        # Only accept methods with perfect scores (10)
                        if score >= 9:
                            validated_methods.append(method)
                            self.debug.log(f"  Method {i+1}: VALID (score: {score})")
                        else:
                            self.debug.log(f"  Method {i+1}: REJECTED - Score {score} too low (need ≥9)")
                    else:
                        self.debug.log(f"  Method {i+1}: INVALID - {validation.issues}")
                except Exception as e:
                    self.debug.log(f"  Method {i+1}: Validation failed: {e}")
            
            self.debug.log(f"Pipeline complete: {len(validated_methods)} valid methods")
            return validated_methods
            
        except Exception as e:
            self.debug.log(f"Pipeline failed: {e}")
            return []
    
    def validate_and_rank_methods(self, methods: List[Dict]) -> Dict:
        """Strict validation - only accept zero-installation methods"""
        if not methods:
            return {"action": "delete", "reason": "No valid methods found", "perfect_methods": []}
        
        # Normalize and filter to only perfect methods (score >= 9)
        normalized_methods = [self._normalize_method_structure(m) for m in methods]
        zero_install_methods = [m for m in normalized_methods if m.get('deployment_score', 0) >= 9]
        
        if not zero_install_methods:
            return {
                "action": "delete",
                "reason": "No zero-installation methods available",
                "perfect_methods": []
            }
        
        # BYPASS AI RANKER - We already validated these as zero-install
        # The ranker was incorrectly filtering out Docker methods because it thinks
        # Docker needs to be "installed first", but we consider Docker/npx/uvx 
        # as standard pre-installed tools that developers have available
        
        self.debug.log(f"Step 6: Bypassing ranker - keeping all {len(zero_install_methods)} zero-install methods")
        method_summaries = []
        for m in zero_install_methods:
            # Ensure method has required fields
            m = self._normalize_method_structure(m)
            icon = self._get_method_icon(m)
            method_summaries.append(f"{icon} {m['name']} ({m.get('type', 'stdio')})")
        self.debug.log(f"Methods to keep: {method_summaries}")
        
        return {
            "action": "keep",
            "reason": f"Found {len(zero_install_methods)} zero-installation methods",
            "perfect_methods": zero_install_methods
        }
    
    def _combine_documentation(self, docs: Dict[str, str]) -> str:
        """Combine documentation files into single context"""
        combined = ""
        priority = ['README.md']
        
        # Add priority files first
        for key in priority:
            if key in docs:
                combined += f"\n=== {key} ===\n{docs[key]}\n"
        
        # Add remaining files
        for key, content in docs.items():
            if key not in priority:
                combined += f"\n=== {key} ===\n{content[:5000]}\n"  # Limit each file
        
        return combined
    
    def _add_known_remote_methods(self, methods: List[Dict], server_data: Dict) -> List[Dict]:
        """Add known remote service methods for recognized servers"""
        server_name = server_data.get('server_name', '').lower()
        
        # Known remote server mappings
        known_remotes = {
            'github/github-mcp-server': {
                'url': 'https://api.githubcopilot.com/mcp/',
                'type': 'http',
                'env_vars': {
                    'GITHUB_PERSONAL_ACCESS_TOKEN': 'GitHub Personal Access Token for API authentication'
                },
                'headers': {
                    'Authorization': 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'
                }
            },
            # Add more known servers here as needed
        }
        
        if server_name in known_remotes:
            remote_config = known_remotes[server_name]
            
            remote_method = {
                'name': f"{server_name}-remote",
                'command': remote_config['url'],
                'type': remote_config['type'],
                'registry': 'remote',
                'package': remote_config['url'],
                'runtime': 'http',
                'deployment_score': 10,
                'env_vars': remote_config.get('env_vars', {}),
                'parameters': [],
                'headers': remote_config.get('headers', {}),
                'description': f'Remote API endpoint for {server_name}'
            }
            
            # Check if we already have a remote method to avoid duplicates
            has_remote = any(m.get('type') == 'http' for m in methods)
            if not has_remote:
                methods.append(remote_method)
                self.debug.log(f"  Added known remote method for {server_name}: {remote_config['url']}")
        
        return methods
    
    def parse_mcp_json_configs(self, content: str) -> List[Dict]:
        """Extract MCP JSON configurations from documentation"""
        configs = []
        seen_commands = set()  # For deduplication
        
        # Find JSON code blocks with better patterns
        json_blocks = re.findall(r'```json\s*\n(.*?)\n```', content, re.DOTALL)
        json_blocks.extend(re.findall(r'```\s*\n(\{.*?\})\s*\n```', content, re.DOTALL))
        # Also find JSON without markdown formatting
        json_blocks.extend(re.findall(r'(\{[^{}]*"servers"[^{}]*\{.*?\}[^{}]*\})', content, re.DOTALL))
        
        self.debug.log(f"Found {len(json_blocks)} potential JSON blocks to parse")
        
        for i, block in enumerate(json_blocks):
            try:
                data = json.loads(block.strip())
                self.debug.log(f"  JSON Block {i+1}: Successfully parsed")
                
                # Check for MCP server configurations (handle nested structures)
                servers = None
                inputs = None
                config_source = None
                
                if 'mcp' in data:
                    # Handle nested mcp.servers structure
                    if 'servers' in data['mcp']:
                        servers = data['mcp']['servers']
                        config_source = "mcp.servers"
                    if 'inputs' in data['mcp']:
                        inputs = data['mcp']['inputs']
                elif 'servers' in data:
                    servers = data['servers']
                    config_source = "servers"
                elif 'mcpServers' in data:
                    servers = data['mcpServers']
                    config_source = "mcpServers"
                elif 'context_servers' in data:
                    servers = data['context_servers']
                    config_source = "context_servers"
                
                if servers:
                    self.debug.log(f"    Found servers in: {config_source}")
                    for server_name, server_config in servers.items():
                        method = self._convert_json_config_to_method(server_name, server_config, inputs)
                        if method:
                            configs.append(method)
                            self.debug.log(f"    Added method: {method['name']} ({method['type']})")
                else:
                    self.debug.log(f"    No servers found in JSON structure")
                            
            except (json.JSONDecodeError, KeyError) as e:
                self.debug.log(f"  JSON Block {i+1}: Parse failed - {e}")
                continue
        
        # Smart deduplication - prefer cleaner versions
        return self._deduplicate_methods(configs)
    
    def _deduplicate_methods(self, methods: List[Dict]) -> List[Dict]:
        """Smart deduplication that prefers cleaner versions"""
        if not methods:
            return methods
        
        # Group methods by type and core command
        groups = {}
        
        for method in methods:
            key = self._get_method_key(method)
            if key not in groups:
                groups[key] = []
            groups[key].append(method)
        
        # For each group, pick the best method
        deduplicated = []
        for key, group_methods in groups.items():
            best_method = self._pick_best_method(group_methods)
            deduplicated.append(best_method)
            
            if len(group_methods) > 1:
                self.debug.log(f"Deduplicated {len(group_methods)} similar methods to: {best_method['command']}")
        
        return deduplicated
    
    def _get_method_key(self, method: Dict) -> str:
        """Generate a key for grouping similar methods"""
        cmd = method.get('command', '')
        method_type = method.get('type', 'stdio')  # Default to stdio if missing
        
        # Strip Windows wrapper commands for deduplication
        clean_cmd = cmd
        if cmd.startswith('cmd /c '):
            clean_cmd = cmd[7:]  # Remove 'cmd /c '
        
        if method_type == 'http' or 'http' in cmd:
            # HTTP methods: group by URL (no deduplication needed usually)
            return f"http:{clean_cmd}"
        else:
            # For stdio commands, extract base package/image name
            if 'npx' in clean_cmd and '@' in clean_cmd:
                # Extract base npm package name (ignore versions and flags)
                import re
                match = re.search(r'@([^@\s]+)', clean_cmd)
                if match:
                    base_package = match.group(1).split('@')[0]  # Remove version
                    return f"npm:{base_package}"
            elif 'docker run' in clean_cmd:
                # Extract base docker image name
                parts = clean_cmd.split()
                if len(parts) > 2:
                    image = parts[-1].split(':')[0]  # Remove tag
                    return f"docker:{image}"
            elif 'uvx' in clean_cmd:
                # Extract base python package name
                parts = clean_cmd.split()
                if len(parts) > 1:
                    package = parts[1].split('@')[0]  # Remove version
                    return f"uvx:{package}"
        
        # Fallback to cleaned command
        return f"{method_type}:{clean_cmd}"
    
    def _pick_best_method(self, methods: List[Dict]) -> Dict:
        """Pick the best method from a group of similar methods"""
        if len(methods) == 1:
            return methods[0]
        
        # Scoring criteria (higher is better)
        def score_method(method):
            cmd = method.get('command', '')
            score = 0
            
            # Prefer methods without version specifiers or with @latest
            if '@latest' in cmd:
                score += 10
            elif '@' not in cmd or cmd.count('@') == 1:  # Only package scope, no version
                score += 15
            elif re.search(r'@\d+\.\d+\.\d+', cmd):  # Specific version
                score -= 5
            
            # Prefer simpler commands (fewer flags)
            if '--node-options' in cmd:
                score -= 3
            if '--experimental' in cmd:
                score -= 2
            if 'cmd /c' in cmd:  # Windows-specific
                score -= 5
            
            # Prefer standard commands
            if cmd.startswith('npx -y ') and cmd.count(' ') <= 3:
                score += 5
            if cmd.startswith('docker run ') and '-i --rm' in cmd:
                score += 5
                
            return score
        
        # Sort by score and return the best
        best_method = max(methods, key=score_method)
        return best_method
    
    def _convert_json_config_to_method(self, name: str, config: Dict, inputs: List[Dict] = None) -> Optional[Dict]:
        """Convert MCP JSON config to method object"""
        method = {
            "name": name,
            "env_vars": {},
            "parameters": [],
            "deployment_score": 1
        }
        
        # Handle command-based servers (stdio)
        if 'command' in config:
            cmd = config['command']
            args = config.get('args', [])
            
            if isinstance(cmd, dict) and 'path' in cmd:
                # New format: {"command": {"path": "npx", "args": [...]}}
                path = cmd['path']
                args = cmd.get('args', [])
            elif isinstance(cmd, str):
                # Direct format: {"command": "docker", "args": [...]}
                path = cmd
            else:
                return None
                
            # Build full command
            full_command = f"{path} {' '.join(args)}"
            method['command'] = full_command
            method['type'] = 'stdio'
            
            # Check if it's zero-installation
            if self._is_zero_install_command(full_command):
                method['deployment_score'] = 10
                if path == 'npx':
                    method['registry'] = 'npm'
                    # Extract package name
                    for arg in args:
                        if arg.startswith('@') or (not arg.startswith('-') and arg != 'npx'):
                            method['package'] = arg
                            break
                    method['runtime'] = 'npx'
                elif path == 'uvx':
                    method['registry'] = 'pypi'
                    method['package'] = args[0] if args else 'unknown'
                    method['runtime'] = 'uvx'
                elif path == 'docker' and 'run' in args:
                    method['registry'] = 'docker'
                    # Extract Docker image using same logic as normalization
                    skip_next = False
                    for i, arg in enumerate(args):
                        if skip_next:
                            skip_next = False
                            continue
                        if arg in ['-v', '--volume', '-e', '--env']:
                            skip_next = True
                            continue
                        if arg.startswith('-'):
                            continue
                        if arg in ['run']:
                            continue
                        # This should be the Docker image
                        if '/' in arg and not arg.startswith('/'):
                            method['package'] = arg
                            break
                    method['runtime'] = 'docker'
            
            # Handle environment variables
            if 'env' in config:
                for env_var, env_value in config['env'].items():
                    if '${input:' in env_value:
                        # The env_var itself is what we need, not the input name
                        # e.g. "GITHUB_PERSONAL_ACCESS_TOKEN": "${input:github_token}" 
                        # means we need GITHUB_PERSONAL_ACCESS_TOKEN, not github_token
                        method['env_vars'][env_var] = f"Required environment variable"
                
        # Handle HTTP servers
        elif 'url' in config or 'type' in config and config.get('type') in ['http', 'sse']:
            method['command'] = config.get('url', '')
            method['type'] = config.get('type', 'http')
            method['deployment_score'] = 10
            method['registry'] = 'remote'
            method['runtime'] = 'http'
            
            # Store headers for later use in package arguments
            if 'headers' in config:
                method['headers'] = config['headers']
                for key, value in config['headers'].items():
                    if '${' in value:
                        # Extract environment variable name - handle both input: and direct patterns
                        env_var_match = re.search(r'\$\{(?:input:)?([^}]+)\}', value)
                        if env_var_match:
                            env_var_name = env_var_match.group(1)
                            method['env_vars'][env_var_name] = f"Required for {key} header authentication"
        
        return method if method['deployment_score'] >= 9 else None
    
    def _is_zero_install_command(self, command: str) -> bool:
        """Check if command requires zero installation"""
        zero_install_patterns = [
            r'npx\s+',          # npx (with or without -y, both auto-install)
            r'uvx\s+',          # uvx auto-install
            r'docker\s+run',    # docker (assumed available)
            r'https?://'        # remote servers
        ]
        return any(re.search(pattern, command, re.IGNORECASE) for pattern in zero_install_patterns)
    
    def _normalize_method_structure(self, method: Dict) -> Dict:
        """Ensure method has all required fields with defaults"""
        normalized = method.copy()
        
        # Ensure essential fields exist
        if 'name' not in normalized:
            normalized['name'] = 'unknown'
        if 'command' not in normalized:
            normalized['command'] = ''
        if 'env_vars' not in normalized:
            normalized['env_vars'] = {}
        if 'parameters' not in normalized:
            normalized['parameters'] = []
        if 'deployment_score' not in normalized:
            normalized['deployment_score'] = 1
            
        # Handle env field from method configuration
        if 'env' in method:
            env_config = method['env']
            if isinstance(env_config, dict):
                for var_name, var_value in env_config.items():
                    # If value looks like a placeholder, it's a required env var
                    if (isinstance(var_value, str) and 
                        ('your-' in var_value.lower() or 
                         'api-key' in var_value.lower() or
                         'token' in var_value.lower() or
                         'key' in var_value.lower())):
                        normalized['env_vars'][var_name] = f'Required environment variable: {var_name}'
            
        # Infer type if missing
        if 'type' not in normalized:
            cmd = normalized['command']
            if cmd.startswith('http://') or cmd.startswith('https://'):
                normalized['type'] = 'http'
            else:
                normalized['type'] = 'stdio'
                
        # Infer registry if missing
        if 'registry' not in normalized:
            cmd = normalized['command']
            if 'npx' in cmd:
                normalized['registry'] = 'npm'
            elif 'uvx' in cmd:
                normalized['registry'] = 'pypi'
            elif 'docker' in cmd:
                normalized['registry'] = 'docker'
            elif normalized['type'] == 'http':
                normalized['registry'] = 'remote'
            else:
                normalized['registry'] = 'unknown'
                
        # Infer runtime if missing or ensure it's a string
        if 'runtime' not in normalized or not isinstance(normalized.get('runtime'), str):
            registry = normalized['registry']
            if registry == 'npm':
                normalized['runtime'] = 'npx'
            elif registry == 'pypi':
                normalized['runtime'] = 'uvx'
            elif registry == 'docker':
                normalized['runtime'] = 'docker'
            elif registry == 'remote':
                normalized['runtime'] = 'http'
            else:
                normalized['runtime'] = 'unknown'
                
        # Infer package if missing
        if 'package' not in normalized or normalized['package'] in [None, 'N/A']:
            cmd = normalized['command']
            if 'npx' in cmd and '@' in cmd:
                match = re.search(r'@([^\s]+)', cmd)
                if match:
                    normalized['package'] = match.group(1)
            elif 'uvx' in cmd:
                parts = cmd.split()
                if len(parts) > 1:
                    normalized['package'] = parts[1]
            elif 'docker run' in cmd:
                parts = cmd.split()
                # Find the Docker image - skip volume mounts and other flags
                skip_next = False
                for i, part in enumerate(parts):
                    if skip_next:
                        skip_next = False
                        continue
                    if part in ['-v', '--volume', '-e', '--env']:
                        skip_next = True  # Skip the next argument (value for this flag)
                        continue
                    if part.startswith('-'):
                        continue
                    if part in ['docker', 'run']:
                        continue
                    # This should be the Docker image
                    if '/' in part and not part.startswith('/'):
                        normalized['package'] = part
                        break
                else:
                    # Fallback: find last non-flag argument
                    for part in reversed(parts):
                        if not part.startswith('-') and not part.startswith('GITHUB_') and part not in ['docker', 'run']:
                            normalized['package'] = part
                            break
            else:
                normalized['package'] = normalized['name']
        
        # Extract parameters and environment variables from command
        if 'parameters' not in normalized or not normalized['parameters']:
            normalized['parameters'] = self._extract_parameters_from_command(normalized['command'])
        if 'env_vars' not in normalized or not normalized['env_vars']:
            normalized['env_vars'] = self._extract_env_vars_from_command(normalized['command'])
        else:
            # Merge command-extracted env vars with existing ones
            normalized['env_vars'].update(self._extract_env_vars_from_command(normalized['command']))
        
        return normalized
    
    def _get_cli_flags_knowledge(self):
        """CLI flags knowledge base for proper parsing"""
        return {
            'docker': {
                'boolean': ['-i', '--interactive', '-t', '--tty', '-d', '--detach', 
                           '--rm', '--privileged', '--no-healthcheck', '--init'],
                'value': ['-e', '--env', '-v', '--volume', '-p', '--publish',
                         '--name', '--network', '--user', '-u', '--workdir', '-w',
                         '--memory', '-m', '--cpus', '--label', '-l', '--restart']
            },
            'npx': {
                'boolean': ['-y', '--yes', '--no-install', '--quiet', '-q',
                           '--verbose', '--debug', '--dry-run'],
                'value': ['--registry', '--prefix', '--workspace', '-w']
            },
            'uvx': {
                'boolean': ['--quiet', '--no-cache', '--isolated', '--force'],
                'value': ['--python', '-p', '--index-url', '--extra-index-url', '--from']
            },
            'config': {  # Configuration parameters (always take values)
                'value': ['--api-key', '--token', '--auth', '--key', '--secret',
                         '--url', '--host', '--port', '--config', '--file', '-f',
                         '--output', '-o', '--input', '--path', '--database',
                         '--figma-api-key', '--github-token', '--openai-api-key']
            }
        }

    def _flag_takes_value(self, flag, command_type):
        """Check if a flag takes a value based on CLI conventions"""
        flags = self._get_cli_flags_knowledge()
        
        # Check command-specific flags
        if command_type in flags:
            if flag in flags[command_type]['value']:
                return True
            if flag in flags[command_type]['boolean']:
                return False
        
        # Check config parameters (always take values)
        if flag in flags['config']['value']:
            return True
        
        # Heuristic fallback: most --long-flags take values
        if flag.startswith('--') and len(flag) > 3:
            return True
        
        return False
    
    def _is_operational_flag(self, flag, cmd_type):
        """Check if this is an operational flag (not user configurable)"""
        operational_flags = {
            'docker': ['-e', '--env', '-v', '--volume', '-p', '--publish',
                      '--name', '--network', '--user', '-u', '--workdir', '-w',
                      '--memory', '-m', '--cpus', '--label', '-l', '--restart'],
            'npx': [],  # Most npx flags are user configurable
            'uvx': ['--python', '-p', '--index-url', '--extra-index-url']  # Tool management, not user config
        }
        
        return flag in operational_flags.get(cmd_type, [])
    
    def _parse_command_args(self, command):
        """Parse command following standard CLI conventions"""
        parts = command.split()
        if not parts:
            return [], {}
        
        # Determine command type
        cmd_type = 'unknown'
        if 'docker' in parts[0]:
            cmd_type = 'docker'
        elif 'npx' in command:
            cmd_type = 'npx'
        elif 'uvx' in command:
            cmd_type = 'uvx'
        
        args = []
        config_params = {}
        
        i = 0
        while i < len(parts):
            part = parts[i]
            
            if part.startswith('-'):
                # It's a flag
                if '=' in part:
                    # Format: --flag=value
                    flag, value = part.split('=', 1)
                    args.extend([flag, value])
                    # All flags are configurable except operational ones
                    if not self._is_operational_flag(flag, cmd_type):
                        config_params[flag] = value
                else:
                    # Check if this flag takes a value
                    if self._flag_takes_value(part, cmd_type):
                        # Next item should be the value
                        args.append(part)
                        if i + 1 < len(parts) and not parts[i + 1].startswith('-'):
                            value = parts[i + 1]
                            args.append(value)
                            
                            # All flags that take values are potentially configurable,
                            # except operational flags
                            if not self._is_operational_flag(part, cmd_type):
                                config_params[part] = value
                            
                            i += 2
                            continue
                        else:
                            # Flag expects value but none found - treat as boolean
                            pass
                    else:
                        # Boolean flag - also configurable unless operational
                        args.append(part)
                        if not self._is_operational_flag(part, cmd_type):
                            config_params[part] = True  # Boolean flag with True as default
            else:
                # Positional argument
                args.append(part)
            
            i += 1
        
        return args, config_params
    
    def _extract_parameters_from_command(self, command: str) -> List[str]:
        """Extract configurable parameters from command"""
        if not command:
            return []
        
        args, config_params = self._parse_command_args(command)
        
        parameters = []
        for flag, value in config_params.items():
            # All config parameters are included with their default values
            if isinstance(value, bool):
                # Boolean flag
                parameters.append(f"{flag}")
            else:
                # Flag with value
                parameters.append(f"{flag}={value}")
        
        return parameters
    
    def _is_placeholder_value(self, value):
        """Check if value is a placeholder that users need to replace"""
        if not value:
            return False
        
        placeholder_indicators = [
            # Common placeholder patterns
            value.startswith(('YOUR_', 'MY_', 'EXAMPLE_', 'TEST_', 'SAMPLE_')),
            value.endswith(('_HERE', '_PLACEHOLDER', '_EXAMPLE')),
            value.startswith('<') and value.endswith('>'),
            value.startswith('{') and value.endswith('}'),
            # Common placeholder values
            value.upper() in ['CHANGEME', 'REPLACEME', 'TODO', 'FIXME'],
            # All caps suggesting placeholder (but not actual env vars)
            (value.isupper() and any(word in value.upper() for word in 
             ['YOUR', 'EXAMPLE', 'TEST', 'API', 'KEY', 'TOKEN']) and
             not value.startswith(('HTTP', 'HTTPS', 'FTP')))
        ]
        
        return any(placeholder_indicators)
    
    def _likely_needs_env_var(self, flag, value):
        """Check if a parameter likely needs an environment variable"""
        if not isinstance(value, str):
            return False
        
        # Obvious cases: values that look like placeholders or secrets
        if self._is_placeholder_value(value):
            return True
        
        # Flag name suggests it's for secrets/credentials
        flag_lower = flag.lower()
        secret_indicators = ['key', 'token', 'secret', 'password', 'auth', 'credential', 'pass']
        if any(indicator in flag_lower for indicator in secret_indicators):
            return True
        
        # Value looks like a path that might contain sensitive info
        if value.startswith(('/', './', '../', '~/')):
            return False  # Paths usually don't need env vars
        
        # Value looks like a URL with placeholder
        if 'example.com' in value.lower() or 'your-' in value.lower():
            return True
        
        return False
    
    def _extract_env_vars_from_command(self, command: str) -> Dict[str, str]:
        """Extract environment variable references from command using CLI parsing"""
        env_vars = {}
        
        if not command:
            return env_vars
        
        # Parse command arguments properly
        args, config_params = self._parse_command_args(command)
        
        # Extract from Docker -e flags
        if 'docker' in command:
            i = 0
            while i < len(args):
                if args[i] in ['-e', '--env'] and i + 1 < len(args):
                    env_var = args[i + 1]
                    # Handle -e VAR=value format
                    if '=' in env_var:
                        var_name = env_var.split('=')[0]
                    else:
                        var_name = env_var
                    
                    if var_name and not var_name.startswith('-'):
                        env_vars[var_name] = 'Docker environment variable'
                    i += 2
                else:
                    i += 1
        
        # Extract from configuration parameters that likely need environment variables
        for flag, value in config_params.items():
            if isinstance(value, str) and self._likely_needs_env_var(flag, value):
                # Convert to environment variable name
                env_var_name = self._infer_env_var_name(flag, value)
                env_vars[env_var_name] = f'Configuration for {flag} parameter'
        
        # Extract from explicit environment variable references
        env_patterns = [
            r'\$\{([^}]+)\}',  # ${VAR_NAME}
            r'\$([A-Z_][A-Z_0-9]*)',  # $VAR_NAME (must start with letter/underscore)
        ]
        
        for pattern in env_patterns:
            matches = re.findall(pattern, command)
            for var_name in matches:
                if var_name and not var_name.lower() in ['path', 'home', 'user']:  # Skip common system vars
                    env_vars[var_name] = 'Environment variable reference'
        
        return env_vars
    
    def _infer_env_var_name(self, flag, placeholder_value):
        """Infer environment variable name from placeholder value"""
        if placeholder_value:
            # Use the actual placeholder value, just normalize it to valid env var format
            # YOUR-KEY -> YOUR_KEY
            # YOUR_API_KEY -> YOUR_API_KEY (unchanged)
            # MyApiKey -> MY_API_KEY
            normalized = placeholder_value.replace('-', '_').replace(' ', '_')
            
            # Convert camelCase to UPPER_CASE if needed
            # MyApiKey -> MY_API_KEY
            if not normalized.isupper():
                # Insert underscores before uppercase letters (except first)
                import re
                normalized = re.sub('([a-z0-9])([A-Z])', r'\1_\2', normalized)
                normalized = normalized.upper()
            
            return normalized
        
        # Fallback: convert flag name to env var format
        # --api-key -> API_KEY
        return flag.lstrip('-').upper().replace('-', '_')
    
    def _get_method_icon(self, method: Dict) -> str:
        """Get icon based on method type and registry"""
        registry = method.get('registry', '')
        method_type = method.get('type', '')
        command = method.get('command', '')
        
        if method_type == 'http' or registry == 'remote':
            return '🌐'  # HTTP/Remote
        elif registry == 'npm' or 'npx' in command:
            return '📦'  # NPM
        elif registry == 'docker' or 'docker run' in command:
            return '🐳'  # Docker
        elif registry == 'pypi' or 'uvx' in command:
            return '🐍'  # Python
        else:
            return '⚙️'   # General/Unknown

# ============================================================================
# DATABASE OPERATIONS
# ============================================================================

class Database:
    """Database operations manager"""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = None
    
    def __enter__(self):
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.conn:
            self.conn.close()
    
    def get_servers_for_validation(self, force: bool = False) -> List[Dict]:
        """Get servers that need validation"""
        query = """
        SELECT DISTINCT
            s.id as server_id,
            s.name as server_name,
            s.repository_url,
            g.language,
            g.stars
        FROM servers s
        LEFT JOIN github_data g ON s.id = g.server_id
        WHERE s.ai_deleted = 0
        """
        
        if not force:
            query += """
            AND (s.ai_analyzed_at IS NULL OR 
                 datetime(s.ai_analyzed_at) < datetime('now', '-5 days'))
            """
        
        query += " ORDER BY g.stars DESC"
        
        cursor = self.conn.execute(query)
        return [dict(row) for row in cursor.fetchall()]
    
    def update_server(self, server_id: str, decision: str, methods: List[Dict], reason: str, debug: Debug = None, validation_log: str = ''):
        """Update server based on AI decision"""
        with self.conn:
            if decision == "keep" and methods:
                # Clean old packages
                self.conn.execute("DELETE FROM packages WHERE server_id = ?", (server_id,))
                
                # Create new packages for perfect methods
                valid_methods = []
                for method in methods:
                    # Skip methods without proper commands
                    command = method.get('command', '').strip()
                    registry = method.get('registry', 'unknown')
                    
                    if not command or command == '' or registry == 'unknown':
                        if debug and debug.enabled:
                            debug.log(f"    Skipping invalid method: empty command or unknown registry")
                        continue
                    package = method.get('package', method.get('name', 'unknown'))
                    runtime = method.get('runtime', 'unknown')
                    
                    # Ensure runtime is a string
                    if not isinstance(runtime, str):
                        runtime = 'unknown'
                    
                    if debug and debug.enabled:
                        debug.log(f"    Saving to DB: registry={registry}, package={package}, runtime={runtime}")
                    
                    cursor = self.conn.execute("""
                        INSERT INTO packages (server_id, registry_name, package_name, version, runtime_hint)
                        VALUES (?, ?, ?, ?, ?)
                    """, (
                        server_id,
                        registry,
                        package,
                        'latest',
                        runtime
                    ))
                    
                    # Get the package ID for foreign key relationships
                    package_id = cursor.lastrowid
                    
                    # Save environment variables to database
                    for env_name, env_desc in method.get('env_vars', {}).items():
                        # Determine if this is a secret (API keys, tokens, etc.)
                        is_secret = any(keyword in env_name.upper() for keyword in ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'AUTH'])
                        
                        if debug and debug.enabled:
                            debug.log(f"    Saving env var: {env_name} (secret: {is_secret})")
                        
                        self.conn.execute("""
                            INSERT INTO environment_variables 
                            (package_id, name, description, is_required, is_secret)
                            VALUES (?, ?, ?, ?, ?)
                        """, (package_id, env_name, env_desc, 1, is_secret))
                    
                    # Save package arguments to database
                    method_type = method.get('type', 'stdio')
                    
                    if method_type == 'http' and method.get('command'):
                        # For HTTP/remote packages, save the URL as a special argument
                        url = method.get('command')
                        if debug and debug.enabled:
                            debug.log(f"    Saving remote URL: {url}")
                        
                        self.conn.execute("""
                            INSERT INTO package_arguments 
                            (package_id, type, name, value, description)
                            VALUES (?, ?, ?, ?, ?)
                        """, (package_id, 'url', 'endpoint', url, 'API endpoint URL'))
                        
                        # Save any headers that need environment variables
                        if 'headers' in method:
                            for header_name, header_value in method['headers'].items():
                                self.conn.execute("""
                                    INSERT INTO package_arguments 
                                    (package_id, type, name, value, description)
                                    VALUES (?, ?, ?, ?, ?)
                                """, (package_id, 'header', header_name, header_value, f'HTTP header: {header_name}'))
                    
                    elif registry == 'docker':
                        # For Docker packages, save proper run arguments
                        docker_args = ['run', '-i', '--rm']
                        
                        # Add environment variable flags
                        for env_var in method.get('env_vars', {}).keys():
                            docker_args.extend(['-e', env_var])
                        
                        # Add the Docker image
                        docker_args.append(package)
                        
                        if debug and debug.enabled:
                            debug.log(f"    Saving Docker args: {' '.join(docker_args)}")
                        
                        for i, arg in enumerate(docker_args):
                            self.conn.execute("""
                                INSERT INTO package_arguments 
                                (package_id, type, value, description)
                                VALUES (?, ?, ?, ?)
                            """, (package_id, 'positional', arg, f'Docker argument {i+1}'))
                    
                    elif method.get('parameters'):
                        # Save any additional parameters for npm/pypi packages
                        for param in method.get('parameters', []):
                            if isinstance(param, str):
                                # Parse parameter format like "--param=value"
                                if '=' in param:
                                    param_name, param_value = param.split('=', 1)
                                    self.conn.execute("""
                                        INSERT INTO package_arguments 
                                        (package_id, type, name, value)
                                        VALUES (?, ?, ?, ?)
                                    """, (package_id, 'named', param_name, param_value))
                                else:
                                    self.conn.execute("""
                                        INSERT INTO package_arguments 
                                        (package_id, type, value)
                                        VALUES (?, ?, ?)
                                    """, (package_id, 'positional', param))
                    
                    valid_methods.append(method)
                
                # If no valid methods were saved, mark server for deletion instead
                if not valid_methods:
                    if debug and debug.enabled:
                        debug.log(f"    No valid methods to save, marking for deletion")
                    
                    detailed_comment = f"AI Decision: No valid installation commands found\n\n{reason}"
                    if validation_log:
                        detailed_comment = f"AI Decision: No valid installation commands found\n\nValidation Details:\n{validation_log}"
                    
                    self.conn.execute("""
                        UPDATE servers 
                        SET ai_deleted = 1, 
                            ai_comment = ?,
                            ai_analyzed_at = datetime('now')
                        WHERE id = ?
                    """, (detailed_comment, server_id))
                    return
                
                # Update timestamp
                self.conn.execute(
                    "UPDATE servers SET ai_analyzed_at = datetime('now') WHERE id = ?",
                    (server_id,)
                )
            else:
                # Mark for deletion with detailed validation log
                detailed_comment = f"AI Decision: {reason}"
                if validation_log:
                    detailed_comment = f"AI Decision: {reason}\n\nValidation Details:\n{validation_log}"
                    
                self.conn.execute("""
                    UPDATE servers 
                    SET ai_deleted = 1, 
                        ai_comment = ?,
                        ai_analyzed_at = datetime('now')
                    WHERE id = ?
                """, (detailed_comment, server_id))

# ============================================================================
# GITHUB OPERATIONS  
# ============================================================================

class GitHub:
    """GitHub documentation fetcher"""
    
    def __init__(self, token: Optional[str] = None):
        self.session = requests.Session()
        self.headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        }
        if token:
            self.headers["Authorization"] = f"Bearer {token}"
    
    def fetch_documentation(self, repo_url: str) -> Dict[str, str]:
        """Fetch all documentation from repository including MCP-specific files"""
        parts = self._parse_url(repo_url)
        if not parts:
            return {}
        
        docs = {}
        owner, repo = parts['owner'], parts['repo']
        
        # Fetch README files (priority)
        for name in ["README.md", "readme.md", "Readme.md"]:
            content = self._download_file(owner, repo, name)
            if content:
                docs["README.md"] = content
                break
        
        # Search for MCP-specific files using tree API
        mcp_files = self._find_mcp_files(owner, repo)
        for file_path in mcp_files:
            content = self._download_file(owner, repo, file_path)
            if content:
                docs[file_path] = content
        
        # Fetch examples and configs
        example_files = ["examples/claude_desktop_config.json", "examples/config.json", 
                        "docs/installation.md", "docs/setup.md", "docs/mcp.md"]
        for path in example_files:
            content = self._download_file(owner, repo, path)
            if content:
                docs[path] = content
        
        return docs
    
    def _find_mcp_files(self, owner: str, repo: str) -> List[str]:
        """Find MCP-related .md files only (no source code)"""
        tree_url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1"
        mcp_files = []
        
        try:
            response = self.session.get(tree_url, headers=self.headers, timeout=30)
            if response.status_code == 200:
                tree_data = response.json()
                
                for item in tree_data.get('tree', []):
                    if item['type'] == 'blob':  # Only files, not directories
                        path = item['path']
                        filename = os.path.basename(path)
                        
                        # ONLY .md files - exclude source code
                        if not filename.lower().endswith('.md'):
                            continue
                            
                        # Look for MCP-related documentation
                        path_lower = path.lower()
                        filename_lower = filename.lower()
                        
                        if (
                            'mcp' in filename_lower or 
                            'mcp' in path_lower or
                            filename_lower.startswith('claude') or
                            any(keyword in path_lower for keyword in ['setup', 'install', 'config', 'usage', 'guide', 'doc'])
                        ):
                            mcp_files.append(item['path'])
                            
                        # Limit to prevent too many files
                        if len(mcp_files) >= 30:  # Increased for AWS MCP servers with 50+ implementations
                            break
                            
        except Exception:
            pass  # Fallback gracefully if tree API fails
        
        return mcp_files
    
    def _parse_url(self, url: str) -> Optional[Dict]:
        match = re.search(r'github\.com/([^/]+)/([^/\s\)#]+)', url)
        if match:
            return {
                "owner": match.group(1),
                "repo": match.group(2).replace(".git", "")
            }
        return None
    
    def _download_file(self, owner: str, repo: str, path: str) -> Optional[str]:
        """Download a single file from GitHub"""
        api_url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}"
        
        try:
            response = self.session.get(api_url, headers=self.headers, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if data.get('encoding') == 'base64':
                    import base64
                    return base64.b64decode(data['content']).decode('utf-8')
            return None
        except:
            return None

# ============================================================================
# MAIN VALIDATOR
# ============================================================================

class MCPValidator:
    """Main MCP configuration validator"""
    
    def __init__(self, config: Config):
        self.config = config
        self.debug = Debug(config.debug)
        self.ai = AIEngine(config)
        self.github = GitHub(config.github_token)
        self.validation_log = []  # Store detailed validation log
        
    def validate_server(self, server: Dict) -> bool:
        """Validate a single server"""
        # Initialize validation log for this server
        self.validation_log = []
        self.validation_log.append(f"=== Validating {server['server_name']} ===")
        self.validation_log.append(f"Stars: {server['stars']:,} | Language: {server['language'] or 'Unknown'}")
        self.validation_log.append(f"Repository: {server['repository_url']}")
        
        print(f"\n🔍 Validating: {server['server_name']}")
        print(f"  ⭐ {server['stars']:,} stars | {server['language'] or 'Unknown'}")
        print(f"  🔗 {server['repository_url']}")
        
        # Fetch documentation
        print(f"  📥 Fetching documentation...")
        docs = self.github.fetch_documentation(server['repository_url'])
        if not docs:
            print(f"  ⚠️ No documentation found")
            self.validation_log.append("❌ FAILED: No documentation found")
            server['_decision'] = {
                'action': 'delete',
                'reason': 'No documentation found',
                'perfect_methods': [],
                'validation_log': '\n'.join(self.validation_log)
            }
            return True
        
        print(f"  📚 Found {len(docs)} documents")
        self.validation_log.append(f"📚 Found {len(docs)} documents:")
        for doc_name, content in docs.items():
            self.validation_log.append(f"  - {doc_name} ({len(content):,} chars)")
        
        # Show all documents in debug mode
        if self.debug.enabled:
            for doc_name, content in docs.items():
                self.debug.log(f"Document: {doc_name} ({len(content):,} chars)")
                # Show first few lines as preview
                preview_lines = content.split('\n')[:3]
                for line in preview_lines:
                    if line.strip():
                        self.debug.log(f"  Preview: {line.strip()[:80]}...")
                        break
        
        # Extract and validate methods using multi-step DSPy pipeline
        print(f"  🤖 Running multi-step extraction pipeline...")
        self.validation_log.append("🤖 Running AI extraction pipeline...")
        methods = self.ai.extract_methods(docs, server)
        
        if not methods:
            print(f"  ⚠️ No methods found")
            self.validation_log.append("❌ No valid MCP installation methods found")
            self.validation_log.append("Pipeline returned empty results - either not an MCP server or no zero-install methods available")
            
            # Store decision to mark server for deletion
            server['_decision'] = {
                'action': 'delete',
                'reason': 'No valid MCP installation methods found',
                'perfect_methods': [],
                'validation_log': '\n'.join(self.validation_log)
            }
            return True
        
        print(f"  ✓ Found {len(methods)} validated methods")
        self.validation_log.append(f"✓ Found {len(methods)} validated methods:")
        
        # Log details about each method
        for i, method in enumerate(methods, 1):
            normalized_method = self.ai._normalize_method_structure(method)
            cmd = normalized_method.get('command', 'N/A')
            score = normalized_method.get('deployment_score', 'N/A')
            self.validation_log.append(f"  Method {i}: {cmd} (score: {score})")
        
        # Rank and classify methods
        print(f"  🤖 Ranking and classifying methods...")
        self.validation_log.append("🤖 Ranking and classifying methods...")
        decision = self.ai.validate_and_rank_methods(methods)
        
        # Show final decision
        if decision['action'] == 'keep':
            print(f"  ✅ KEEP: {decision['reason']}")
            print(f"  📦 Perfect methods: {len(decision['perfect_methods'])}")
            self.validation_log.append(f"✅ DECISION: KEEP - {decision['reason']}")
            self.validation_log.append(f"📦 Perfect methods: {len(decision['perfect_methods'])}")
            if self.debug.enabled:
                for i, method in enumerate(decision['perfect_methods'], 1):
                    try:
                        # Normalize method structure to prevent errors
                        normalized_method = self.ai._normalize_method_structure(method)
                        
                        # Get icon based on method type and registry
                        icon = self.ai._get_method_icon(normalized_method)
                        method_name = normalized_method.get('name', 'Unknown')
                        command = normalized_method.get('command', 'N/A')
                        
                        self.debug.log(f"  {icon} Method {i}: {method_name}")
                        self.debug.log(f"    Command: {command}")
                        self.debug.log(f"    Type: {normalized_method.get('type', 'N/A')}")
                        self.debug.log(f"    Registry: {normalized_method.get('registry', 'N/A')}")
                        self.debug.log(f"    Package: {normalized_method.get('package', 'N/A')}")
                        self.debug.log(f"    Runtime: {normalized_method.get('runtime', 'N/A')}")
                        self.debug.log(f"    Score: {normalized_method.get('deployment_score', 'N/A')}")
                        
                        # Show environment variables and parameters
                        env_vars = normalized_method.get('env_vars', {})
                        parameters = normalized_method.get('parameters', [])
                        
                        if env_vars:
                            self.debug.log(f"    Env vars needed:")
                            for var_name, description in env_vars.items():
                                self.debug.log(f"      {var_name}: {description}")
                        else:
                            self.debug.log(f"    Env vars: None required")
                        
                        if parameters:
                            self.debug.log(f"    Parameters: {parameters}")
                        else:
                            self.debug.log(f"    Parameters: None required")
                        
                        self.debug.log("")
                        
                    except Exception as e:
                        self.debug.log(f"  ❌ Error processing Method {i}: {e}")
                        self.debug.log(f"    Raw method: {method}")
                        self.debug.log("")
        else:
            print(f"  🗑️ DELETE: {decision['reason']}")
            self.validation_log.append(f"🗑️ DECISION: DELETE - {decision['reason']}")
        
        # Store decision for database update with validation log
        decision['validation_log'] = '\n'.join(self.validation_log)
        server['_decision'] = decision
        return True
    
    def run(self):
        """Main validation loop"""
        print("🤖 MCP Server Configuration Validator (DSPy Edition)")
        print("=" * 60)
        
        with Database(self.config.db_path) as db:
            servers = db.get_servers_for_validation(self.config.force)
            
            if not servers:
                print("No servers to validate")
                return
            
            print(f"Found {len(servers)} servers to validate\n")
            
            # Apply limit if specified
            if self.config.limit:
                servers = servers[:self.config.limit]
            
            kept = 0
            deleted = 0
            failed = 0
            
            try:
                for i, server in enumerate(servers, 1):
                    print(f"[{i}/{len(servers)}] Processing {server['server_name']}...")
                    
                    try:
                        # Validate server
                        success = self.validate_server(server)
                        
                        if success:
                            # Use stored decision from validate_server
                            decision = server.get('_decision')
                            if decision:
                                # Update database
                                if self.debug.enabled:
                                    self.debug.log("  💾 Updating database:")
                                db.update_server(
                                    server['server_id'],
                                    decision['action'],
                                    decision.get('perfect_methods', []),
                                    decision.get('reason', ''),
                                    self.debug,
                                    decision.get('validation_log', '')
                                )
                                
                                # Track outcome
                                if decision['action'] == 'keep':
                                    kept += 1
                                elif decision['action'] == 'delete':
                                    deleted += 1
                        else:
                            failed += 1
                            
                    except KeyboardInterrupt:
                        print(f"\n\n⏹️  Processing interrupted by user")
                        break
                    except Exception as e:
                        print(f"  ❌ Error: {e}")
                        failed += 1
                    
                    # Rate limiting
                    if i % 5 == 0:
                        time.sleep(2)
                
            except KeyboardInterrupt:
                print(f"\n\n⏹️  Validation interrupted by user")
            
            print(f"\n📊 Summary:")
            print(f"  ✅ Kept: {kept} servers with valid MCP methods")
            print(f"  🗑️ Deleted: {deleted} servers marked for deletion (no valid methods)")
            print(f"  ❌ Failed: {failed} servers with processing errors")

# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Validate MCP server configurations using DSPy")
    parser.add_argument("--model", default="qwen3:30b", help="Ollama model to use")
    parser.add_argument("--db", default="database/servers.db", help="Database path")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    parser.add_argument("--force", action="store_true", help="Process all servers")
    parser.add_argument("--limit", type=int, help="Limit number of servers")
    
    args = parser.parse_args()
    
    config = Config(
        db_path=args.db,
        model=args.model,
        debug=args.debug,
        force=args.force,
        limit=args.limit
    )
    
    validator = MCPValidator(config)
    validator.run()