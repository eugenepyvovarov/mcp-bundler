#!/usr/bin/env python3
"""
Improved MCP Server Authenticity Analysis

Multi-stage approach to identify suspicious entries that may not be actual MCP servers:

Stage 1: Technical Validation (Auto-Accept)
- Check for @modelcontextprotocol/* dependencies
- Validate MCP naming patterns and trusted organizations
- Look for strong technical MCP indicators

Stage 2: Clear Non-MCP Detection (Auto-Reject) 
- Identify obvious non-MCP project types (monitoring, databases, games)
- Pattern matching for system tools, web frameworks, etc.

Stage 3: Conservative AI Assessment (Borderline Cases Only)
- Light analysis for unclear cases
- Focus on obvious mismatches, be lenient with unclear projects

Reduces false positives while catching clear misclassifications.
"""

import json
import sqlite3
import os
import re
import time
from datetime import datetime
from typing import Dict, List, Optional, Any, Tuple
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Configuration
OLLAMA_API_BASE = "http://localhost:11434"
OLLAMA_MODEL = "qwen3:30b"
DATABASE_PATH = "database/servers.db"
GITHUB_API_BASE = "https://api.github.com"

# Trusted organizations (auto-accept as legitimate MCP)
TRUSTED_ORGS = {
    'modelcontextprotocol', 'microsoft', 'github', 'awslabs', 'aws', 
    'cloudflare', 'anthropics', 'anthropic', 'google', 'googleapis',
    'openai', 'huggingface'
}

# Only minimal technical validation for clear-cut cases
DEFINITIVE_MCP_INDICATORS = [
    "@modelcontextprotocol",  # Official MCP packages
]

# Only the most trusted organizations for auto-accept
HIGHLY_TRUSTED_ORGS = {
    'modelcontextprotocol',  # Official MCP org
}

# Headers for GitHub API
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Add GitHub token if available
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
if GITHUB_TOKEN:
    HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"

# Setup session with retry logic
session = requests.Session()
retry = Retry(
    total=3,
    backoff_factor=0.3,
    status_forcelist=[500, 502, 503, 504]
)
adapter = HTTPAdapter(max_retries=retry)
session.mount("http://", adapter)
session.mount("https://", adapter)


def check_ollama_server() -> bool:
    """Check if Ollama server is running and model is available."""
    try:
        response = requests.get(f"{OLLAMA_API_BASE}/api/tags", timeout=5)
        if response.status_code != 200:
            return False
        
        models = response.json().get("models", [])
        model_names = [m.get("name", "") for m in models]
        
        if OLLAMA_MODEL not in model_names:
            print(f"⚠️  Model {OLLAMA_MODEL} not found. Available models:")
            for model in model_names:
                print(f"   - {model}")
            return False
        
        return True
    except Exception as e:
        print(f"❌ Ollama server not accessible: {e}")
        return False


def analyze_with_ollama(prompt: str) -> Optional[str]:
    """Send a prompt to Ollama and get the response."""
    try:
        response = requests.post(
            f"{OLLAMA_API_BASE}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.2,  # Lower temperature for more consistent analysis
                    "top_p": 0.9,
                    "max_tokens": 800
                }
            },
            timeout=90  # Longer timeout for thorough analysis
        )
        
        if response.status_code == 200:
            return response.json().get("response", "").strip()
        else:
            print(f"  ⚠️  Ollama API error: {response.status_code}")
            return None
    except Exception as e:
        print(f"  ⚠️  Ollama request failed: {e}")
        return None


def parse_github_url(url: str) -> Optional[Dict[str, str]]:
    """Extract owner and repo from GitHub URL."""
    if not url:
        return None
    
    match = re.search(r'github\.com/([^/]+)/([^/\s\)#]+)', url)
    if not match:
        return None
    
    return {
        "owner": match.group(1),
        "repo": match.group(2).replace(".git", "")
    }


def fetch_pyproject_toml(repo_url: str) -> Optional[str]:
    """Fetch pyproject.toml content for Python projects."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return None
    
    try:
        endpoint = f"{GITHUB_API_BASE}/repos/{parsed['owner']}/{parsed['repo']}/contents/pyproject.toml"
        response = session.get(
            endpoint,
            headers={**HEADERS, "Accept": "application/vnd.github.raw"},
            timeout=10
        )
        
        if response.status_code == 200:
            return response.text
        return None
    except:
        return None


def minimal_technical_check(server_data: Dict[str, Any], package_json: Optional[Dict], 
                          pyproject_toml: Optional[str]) -> Dict[str, Any]:
    """Minimal technical check for definitive MCP indicators only."""
    
    evidence = []
    auto_accept = False
    
    # Only check for official MCP organization
    repo_name = server_data.get('name', '').lower()
    org_name = repo_name.split('/')[0] if '/' in repo_name else ''
    
    if org_name in HIGHLY_TRUSTED_ORGS:
        auto_accept = True
        evidence.append(f"Official MCP organization: {org_name}")
    
    # Only check for official @modelcontextprotocol packages
    if package_json:
        deps = {**package_json.get("dependencies", {}), **package_json.get("devDependencies", {})}
        mcp_deps = [pkg for pkg in deps.keys() if "@modelcontextprotocol" in pkg]
        if mcp_deps:
            auto_accept = True
            evidence.append(f"Official MCP packages: {', '.join(mcp_deps)}")
    
    return {
        "evidence": evidence,
        "auto_accept": auto_accept
    }


def fetch_readme_content(repo_url: str) -> Optional[str]:
    """Fetch README content from GitHub repository."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return None
    
    try:
        readme_endpoint = f"{GITHUB_API_BASE}/repos/{parsed['owner']}/{parsed['repo']}/readme"
        response = session.get(
            readme_endpoint,
            headers={**HEADERS, "Accept": "application/vnd.github.raw"},
            timeout=10
        )
        
        if response.status_code == 200:
            # Return first 4000 characters for analysis
            return response.text[:4000]
        return None
    except:
        return None




def fetch_package_json(repo_url: str) -> Optional[Dict]:
    """Fetch package.json content if available."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return None
    
    try:
        package_endpoint = f"{GITHUB_API_BASE}/repos/{parsed['owner']}/{parsed['repo']}/contents/package.json"
        response = session.get(
            package_endpoint,
            headers={**HEADERS, "Accept": "application/vnd.github.raw"},
            timeout=10
        )
        
        if response.status_code == 200:
            return json.loads(response.text)
        return None
    except:
        return None


def get_server_data_from_db(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Fetch all server data from the database."""
    cursor = conn.cursor()
    
    query = """
    SELECT 
        s.id,
        s.name,
        s.display_name,
        s.description,
        s.ai_description,
        s.repository_url,
        g.stars,
        g.forks,
        g.language,
        g.license,
        g.description as github_description,
        g.archived,
        GROUP_CONCAT(DISTINCT c.name) as categories,
        GROUP_CONCAT(DISTINCT k.keyword) as keywords,
        GROUP_CONCAT(DISTINCT gt.topic) as github_topics,
        GROUP_CONCAT(DISTINCT p.registry_name || ':' || p.package_name) as packages
    FROM servers s
    LEFT JOIN github_data g ON s.id = g.server_id
    LEFT JOIN server_categories sc ON s.id = sc.server_id
    LEFT JOIN categories c ON sc.category_id = c.id
    LEFT JOIN server_keywords sk ON s.id = sk.server_id
    LEFT JOIN keywords k ON sk.keyword_id = k.id
    LEFT JOIN server_github_topics sgt ON s.id = sgt.server_id
    LEFT JOIN github_topics gt ON sgt.topic_id = gt.id
    LEFT JOIN packages p ON s.id = p.server_id
    GROUP BY s.id
    ORDER BY g.stars DESC
    """
    
    cursor.execute(query)
    columns = [description[0] for description in cursor.description]
    
    servers = []
    for row in cursor.fetchall():
        server_data = dict(zip(columns, row))
        servers.append(server_data)
    
    return servers


def delete_server_from_db(conn: sqlite3.Connection, server_id: str) -> bool:
    """Delete a server and all its related data from the database."""
    cursor = conn.cursor()
    
    try:
        # Start transaction
        conn.execute("BEGIN TRANSACTION")
        
        # Delete from all related tables (foreign key constraints will handle cascading)
        # But let's be explicit for clarity
        
        # Delete environment variables (through packages)
        cursor.execute("""
            DELETE FROM environment_variables 
            WHERE package_id IN (
                SELECT id FROM packages WHERE server_id = ?
            )
        """, (server_id,))
        
        # Delete package arguments (through packages)
        cursor.execute("""
            DELETE FROM package_arguments 
            WHERE package_id IN (
                SELECT id FROM packages WHERE server_id = ?
            )
        """, (server_id,))
        
        # Delete packages
        cursor.execute("DELETE FROM packages WHERE server_id = ?", (server_id,))
        
        # Delete server relationships
        cursor.execute("DELETE FROM server_categories WHERE server_id = ?", (server_id,))
        cursor.execute("DELETE FROM server_keywords WHERE server_id = ?", (server_id,))
        cursor.execute("DELETE FROM server_github_topics WHERE server_id = ?", (server_id,))
        
        # Delete github data
        cursor.execute("DELETE FROM github_data WHERE server_id = ?", (server_id,))
        
        # Finally, delete the server itself
        cursor.execute("DELETE FROM servers WHERE id = ?", (server_id,))
        
        # Commit transaction
        conn.commit()
        
        # Verify deletion
        cursor.execute("SELECT COUNT(*) FROM servers WHERE id = ?", (server_id,))
        if cursor.fetchone()[0] == 0:
            return True
        else:
            return False
            
    except Exception as e:
        print(f"Error deleting server {server_id}: {e}")
        conn.rollback()
        return False


def get_user_confirmation(server_data: Dict[str, Any], ai_analysis: Dict[str, Any]) -> bool:
    """Interactive prompt to get user confirmation for deletion."""
    
    print("\n" + "="*80)
    print("🚨 SUSPICIOUS ENTRY FOUND")
    print("="*80)
    
    print(f"📦 Repository: {server_data['name']}")
    print(f"⭐ Stars: {server_data['stars']:,}")
    print(f"💻 Language: {server_data['language'] or 'Unknown'}")
    print(f"🔗 GitHub: {server_data['repository_url']}")
    print(f"📝 Description: {server_data.get('description') or 'No description'}")
    print(f"🤖 AI Description: {server_data.get('ai_description') or 'No AI description'}")
    
    print(f"\n🤖 AI ANALYSIS:")
    print(f"   Confidence: {ai_analysis.get('confidence', 0)}/10")
    print(f"   Reasoning: {ai_analysis.get('primary_reason', 'No reasoning provided')}")
    print(f"   Project Type: {ai_analysis.get('category', 'Unknown')}")
    print(f"   Evidence: {ai_analysis.get('evidence', 'No evidence provided')}")
    
    print(f"\n🌐 View in browser: {server_data['repository_url']}")
    
    while True:
        print("\n" + "-"*50)
        response = input("❓ Delete this entry from database? [y/n/s]: ").lower().strip()
        
        if response in ['y', 'yes']:
            return True
        elif response in ['n', 'no']:
            return False
        elif response in ['s', 'skip']:
            print("⏭️  Skipping this entry")
            return False
        else:
            print("Please enter 'y' (yes), 'n' (no), or 's' (skip)")
            continue


def comprehensive_ai_analysis(server_data: Dict[str, Any], readme_content: Optional[str], 
                             package_json: Optional[Dict], pyproject_toml: Optional[str]) -> Dict[str, Any]:
    """Use AI to comprehensively analyze if a project is an authentic MCP server."""
    
    # Prepare technical context
    technical_details = []
    
    if package_json:
        deps = {**package_json.get("dependencies", {}), **package_json.get("devDependencies", {})}
        if deps:
            technical_details.append(f"Node.js dependencies: {', '.join(list(deps.keys())[:10])}")
        
        scripts = package_json.get("scripts", {})
        if scripts:
            technical_details.append(f"NPM scripts: {', '.join(scripts.keys())}")
    
    if pyproject_toml:
        technical_details.append("Python project with pyproject.toml")
        if "mcp" in pyproject_toml.lower():
            technical_details.append("MCP mentioned in Python config")
    
    # Build AI prompt with comprehensive context
    context = f"""
You are an expert at analyzing software projects to determine their purpose and authenticity.

TASK: Analyze this GitHub repository to determine if it's genuinely a Model Context Protocol (MCP) server.

WHAT IS AN MCP SERVER:
Model Context Protocol servers are specialized tools that extend AI assistants (like Claude) with additional capabilities. They:
- Implement the MCP specification to communicate with AI clients
- Provide specific tools, resources, or data access to AI assistants
- Enable AI to interact with external services, databases, APIs, file systems, etc.
- Are designed specifically for AI integration, not general-purpose use

PROJECT INFORMATION:
Repository: {server_data.get('name', 'Unknown')}
Display Name: {server_data.get('display_name', 'N/A')}
Description: {server_data.get('description', 'N/A')}
AI Generated Description: {server_data.get('ai_description', 'N/A')}
GitHub Description: {server_data.get('github_description', 'N/A')}
Primary Language: {server_data.get('language', 'Unknown')}
Stars: {server_data.get('stars', 0):,}
GitHub Topics: {server_data.get('github_topics', 'None')}
Categories: {server_data.get('categories', 'None')}
Keywords: {server_data.get('keywords', 'None')}

TECHNICAL DETAILS:
{chr(10).join(technical_details) if technical_details else 'No technical details available'}

README CONTENT (first 2500 characters):
{readme_content[:2500] if readme_content else 'No README content available'}

ANALYSIS INSTRUCTIONS:
Please analyze this project holistically. Consider:

LEGITIMATE MCP SERVER INDICATORS:
- Mentions Model Context Protocol, MCP, or AI assistant integration
- Has @modelcontextprotocol/* dependencies or similar MCP-related packages
- Describes tools/capabilities for AI assistants
- Documentation mentions Claude, AI clients, or protocol implementation
- Repository name suggests MCP functionality
- Code structure typical of server applications

SUSPICIOUS/NON-MCP INDICATORS:
- General-purpose software unrelated to AI assistance
- No mention of AI, assistants, protocols, or MCP anywhere
- Clearly different domain (games, monitoring tools, databases, web frameworks, etc.)
- Personal projects, demos, or learning exercises
- System utilities, development tools not related to AI
- E-commerce, CMS, social media platforms
- Mobile apps, desktop applications for general use

BE NUANCED: Some projects might be AI-related but not specifically MCP servers. Consider the specific purpose and implementation.

Respond in this EXACT format:
LEGITIMATE: [YES/NO]
CONFIDENCE: [1-10, where 10 is completely certain]
REASONING: [Your analysis in 2-3 sentences explaining your decision]
PROJECT_TYPE: [What this project actually is in 1-2 words]
KEY_EVIDENCE: [Most important evidence supporting your conclusion]
"""

    print(f"  🤖 Analyzing {server_data['name']} with AI...")
    response = analyze_with_ollama(context)
    
    if not response:
        return {"error": "Failed to get AI analysis"}
    
    # Parse AI response with new format
    result = {}
    lines = response.strip().split('\n')
    
    for line in lines:
        if line.startswith("LEGITIMATE:"):
            # Note: inverted logic - LEGITIMATE: NO means suspicious
            is_legitimate = line.replace("LEGITIMATE:", "").strip().upper() == "YES"
            result["suspicious"] = not is_legitimate
        elif line.startswith("CONFIDENCE:"):
            try:
                result["confidence"] = int(line.replace("CONFIDENCE:", "").strip())
            except:
                result["confidence"] = 5
        elif line.startswith("REASONING:"):
            result["primary_reason"] = line.replace("REASONING:", "").strip()
        elif line.startswith("KEY_EVIDENCE:"):
            result["evidence"] = line.replace("KEY_EVIDENCE:", "").strip()
        elif line.startswith("PROJECT_TYPE:"):
            result["category"] = line.replace("PROJECT_TYPE:", "").strip()
    
    return result


def analyze_suspicious_servers():
    """Interactive analysis of MCP server authenticity with deletion capability."""
    print("🤖 Interactive MCP Server Cleanup Tool")
    print("=" * 50)
    print("This tool will analyze each server entry and prompt you to delete suspicious ones.")
    print("You can view each repository in your browser before making a decision.")
    
    # Check Ollama availability
    print(f"🤖 Checking Ollama server with {OLLAMA_MODEL} model...")
    if not check_ollama_server():
        print("❌ Ollama not available. Please ensure:")
        print("   1. Ollama is installed and running")
        print(f"   2. Model {OLLAMA_MODEL} is pulled: ollama pull {OLLAMA_MODEL}")
        return
    print(f"✓ Ollama server ready with {OLLAMA_MODEL}")
    
    # Connect to database
    if not os.path.exists(DATABASE_PATH):
        print(f"❌ Database not found: {DATABASE_PATH}")
        return
    
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    
    # Get all server data for interactive processing
    print("\n📊 Loading server data from database...")
    servers = get_server_data_from_db(conn)
    print(f"✓ Found {len(servers)} servers to analyze interactively")
    
    if not servers:
        print("❌ No servers found in database")
        conn.close()
        return
    
    # Interactive processing
    analyzed_count = 0
    deleted_count = 0
    skipped_count = 0
    failed_count = 0
    
    print(f"\n🚀 Starting interactive analysis...")
    print("Note: Projects with @modelcontextprotocol packages are auto-accepted")
    print("Press Ctrl+C at any time to exit\n")
    
    try:
        for i, server in enumerate(servers, 1):
            print(f"\n[{i}/{len(servers)}] Analyzing: {server['name']}")
            print(f"  ⭐ {server['stars']:,} | {server['language'] or 'Unknown'}")
            
            try:
                # Fetch minimal additional data
                package_json = fetch_package_json(server['repository_url'])
                pyproject_toml = fetch_pyproject_toml(server['repository_url'])
                readme_content = fetch_readme_content(server['repository_url'])
                
                # Stage 1: Quick technical check for definitive cases only
                tech_check = minimal_technical_check(server, package_json, pyproject_toml)
                
                if tech_check["auto_accept"]:
                    print(f"  ✅ AUTO-ACCEPTED: {'; '.join(tech_check['evidence'])}")
                    analyzed_count += 1
                    continue
                
                # Stage 2: Comprehensive AI analysis
                print(f"  📊 Fetching data...")
                
                analysis = comprehensive_ai_analysis(server, readme_content, package_json, pyproject_toml)
                
                if "error" in analysis:
                    print(f"  ❌ Analysis failed: {analysis['error']}")
                    failed_count += 1
                    continue
                
                analyzed_count += 1
                
                if analysis.get("suspicious", False):
                    # Interactive confirmation for suspicious entries
                    if get_user_confirmation(server, analysis):
                        # User approved deletion
                        print(f"\n🗑️  Deleting {server['name']} from database...")
                        
                        if delete_server_from_db(conn, server['id']):
                            print(f"  ✅ Successfully deleted {server['name']}")
                            deleted_count += 1
                        else:
                            print(f"  ❌ Failed to delete {server['name']}")
                    else:
                        print(f"  ⏭️  Keeping {server['name']} in database")
                        skipped_count += 1
                else:
                    confidence = analysis.get("confidence", 0)
                    print(f"  ✅ LEGITIMATE (AI confidence: {confidence}/10)")
                
                # Rate limiting
                if i % 10 == 0:
                    print(f"\n⏸️  Brief pause for API rate limits...")
                    time.sleep(1)
                    
            except Exception as e:
                print(f"  ❌ Error analyzing server: {e}")
                failed_count += 1
                continue
                
    except KeyboardInterrupt:
        print(f"\n\n⏹️  Analysis interrupted by user")
    
    conn.close()
    
    # Final summary
    print(f"\n📊 Interactive Cleanup Complete!")
    print("=" * 50)
    print(f"   ✓ Analyzed: {analyzed_count}")
    print(f"   🗑️  Deleted: {deleted_count}")
    print(f"   ⏭️  Skipped: {skipped_count}")
    print(f"   ❌ Failed: {failed_count}")
    
    if deleted_count > 0:
        print(f"\n🎉 Successfully removed {deleted_count} suspicious entries from the database!")
        print("The database has been cleaned up based on AI analysis and your confirmations.")
    else:
        print(f"\n✅ No entries were deleted.")
        if skipped_count > 0:
            print(f"You chose to keep {skipped_count} suspicious entries in the database.")
        else:
            print("All entries appear to be legitimate MCP servers!")
    
    print(f"\n✨ Interactive cleanup complete!")
    print("Note: You can run this tool again anytime to continue cleaning up the database.")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Interactive tool to analyze and remove suspicious/non-MCP entries from database")
    parser.add_argument("--model", default="qwen3:30b", help="Ollama model to use")
    parser.add_argument("--db", default="database/servers.db", help="Database file path")
    
    args = parser.parse_args()
    
    # Update configuration
    if args.model:
        OLLAMA_MODEL = args.model
    if args.db:
        DATABASE_PATH = args.db
    
    if not GITHUB_TOKEN:
        print("💡 Tip: Set GITHUB_TOKEN environment variable for higher rate limits")
        print("   export GITHUB_TOKEN=your_github_personal_access_token")
        print()
    
    analyze_suspicious_servers()