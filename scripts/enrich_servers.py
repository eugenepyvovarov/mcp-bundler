#!/usr/bin/env python3
"""
Enrich MCP servers data from servers.md by fetching GitHub info and AI analysis
This script:
1. Reads servers.md line by line to find GitHub links
2. Fetches repository information and README from GitHub API
3. Uses Ollama for AI-powered analysis
4. Saves to SQLite database using the new data format structure
5. Supports resuming by skipping already processed servers
"""

import json
import re
import time
import sqlite3
import os
import sys
import uuid
from datetime import datetime
from typing import Dict, Optional, Any, List, Tuple
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Configuration
GITHUB_API_BASE = "https://api.github.com"
OLLAMA_API_BASE = "http://localhost:11434"
OLLAMA_MODEL = "qwen3:30b"
DATABASE_PATH = "database/servers.db"
SERVERS_MD_PATH = "scripts/servers.md"

# Headers for GitHub API
HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Add token if available
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
if GITHUB_TOKEN:
    HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    print(f"✓ Using GitHub token for higher rate limits")

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


def init_database() -> sqlite3.Connection:
    """Initialize SQLite database with the proper normalized schema."""
    # Create database directory if it doesn't exist
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Read and execute the schema file if it exists
    schema_path = os.path.join(os.path.dirname(DATABASE_PATH), "schema.sql")
    if os.path.exists(schema_path):
        with open(schema_path, 'r') as f:
            schema_sql = f.read()
            cursor.executescript(schema_sql)
    else:
        # Fallback: create basic tables if schema.sql doesn't exist
        cursor.executescript("""
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT,
            description TEXT,
            ai_description TEXT,
            repository_url TEXT,
            repository_source TEXT,
            repository_id TEXT,
            version TEXT,
            release_date TEXT,
            is_latest BOOLEAN DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ai_analyzed_at TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS github_data (
            server_id TEXT PRIMARY KEY,
            stars INTEGER DEFAULT 0,
            forks INTEGER DEFAULT 0,
            watchers INTEGER DEFAULT 0,
            open_issues INTEGER DEFAULT 0,
            language TEXT,
            license TEXT,
            homepage TEXT,
            description TEXT,
            default_branch TEXT,
            archived BOOLEAN DEFAULT 0,
            github_updated_at TIMESTAMP,
            github_created_at TIMESTAMP,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS packages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL,
            registry_name TEXT NOT NULL,
            package_name TEXT NOT NULL,
            version TEXT,
            runtime_hint TEXT,
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS environment_variables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            package_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            is_required BOOLEAN DEFAULT 0,
            is_secret BOOLEAN DEFAULT 0,
            default_value TEXT,
            format TEXT,
            FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS server_categories (
            server_id TEXT NOT NULL,
            category_id INTEGER NOT NULL,
            PRIMARY KEY (server_id, category_id),
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword TEXT UNIQUE NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS server_keywords (
            server_id TEXT NOT NULL,
            keyword_id INTEGER NOT NULL,
            PRIMARY KEY (server_id, keyword_id),
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
            FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS github_topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic TEXT UNIQUE NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS server_github_topics (
            server_id TEXT NOT NULL,
            topic_id INTEGER NOT NULL,
            PRIMARY KEY (server_id, topic_id),
            FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
            FOREIGN KEY (topic_id) REFERENCES github_topics(id) ON DELETE CASCADE
        );
        """)
    
    conn.commit()
    return conn


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
                    "temperature": 0.3,
                    "top_p": 0.9,
                    "max_tokens": 500
                }
            },
            timeout=90
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
    
    # Clean the URL - remove markdown formatting
    url = url.strip()
    if url.startswith('['):
        # Extract URL from markdown link [text](url)
        match = re.search(r'\]\((https?://[^)]+)\)', url)
        if match:
            url = match.group(1)
    
    match = re.search(r'github\.com/([^/]+)/([^/\s\)#]+)', url)
    if not match:
        return None
    
    return {
        "owner": match.group(1),
        "repo": match.group(2).replace(".git", "")
    }


def fetch_github_info(repo_url: str) -> Optional[Dict[str, Any]]:
    """Fetch repository information from GitHub API."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return None
    
    try:
        repo_endpoint = f"{GITHUB_API_BASE}/repos/{parsed['owner']}/{parsed['repo']}"
        response = session.get(repo_endpoint, headers=HEADERS, timeout=10)
        
        if response.status_code == 404:
            print(f"  ✗ Repository not found: {parsed['owner']}/{parsed['repo']}")
            return None
        elif response.status_code == 403:
            print(f"  ✗ Rate limit reached!")
            check_rate_limit()
            return None
        elif response.status_code != 200:
            print(f"  ✗ Error {response.status_code} for {parsed['owner']}/{parsed['repo']}")
            return None
        
        data = response.json()
        
        github_info = {
            "stars": data.get("stargazers_count", 0),
            "forks": data.get("forks_count", 0),
            "watchers": data.get("watchers_count", 0),
            "open_issues": data.get("open_issues_count", 0),
            "topics": data.get("topics", []),
            "language": data.get("language"),
            "license": data.get("license", {}).get("name") if data.get("license") else None,
            "updated_at": data.get("updated_at"),
            "created_at": data.get("created_at"),
            "archived": data.get("archived", False),
            "description": data.get("description"),
            "homepage": data.get("homepage"),
            "default_branch": data.get("default_branch", "main"),
            "full_name": data.get("full_name")
        }
        
        return github_info
        
    except requests.exceptions.RequestException as e:
        print(f"  ✗ Network error for {repo_url}: {e}")
        return None
    except Exception as e:
        print(f"  ✗ Unexpected error for {repo_url}: {e}")
        return None


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
            # Limit README to first 3000 characters for AI analysis
            return response.text[:3000]
        return None
    except:
        return None


def fetch_package_json(repo_url: str) -> Optional[Dict]:
    """Fetch package.json to identify package info."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return None
    
    try:
        # Try to fetch package.json
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


def check_python_package(repo_url: str) -> bool:
    """Check if repository has Python package files (requirements.txt, setup.py, pyproject.toml)."""
    parsed = parse_github_url(repo_url)
    if not parsed:
        return False
    
    try:
        # Check for common Python package files
        for filename in ["requirements.txt", "setup.py", "pyproject.toml"]:
            endpoint = f"{GITHUB_API_BASE}/repos/{parsed['owner']}/{parsed['repo']}/contents/{filename}"
            response = session.get(endpoint, headers=HEADERS, timeout=5)
            if response.status_code == 200:
                return True
        return False
    except:
        return False


def check_rate_limit():
    """Check GitHub API rate limit status."""
    try:
        response = session.get(f"{GITHUB_API_BASE}/rate_limit", headers=HEADERS, timeout=10)
        if response.status_code == 200:
            data = response.json()
            rate = data.get("rate", {})
            remaining = rate.get("remaining", 0)
            limit = rate.get("limit", 60)
            reset_time = datetime.fromtimestamp(rate.get("reset", 0))
            
            print(f"\n📊 Rate Limit Status:")
            print(f"   Remaining: {remaining}/{limit}")
            print(f"   Resets at: {reset_time.strftime('%H:%M:%S')}")
            
            if remaining == 0:
                wait_seconds = (reset_time - datetime.now()).total_seconds()
                if wait_seconds > 0:
                    print(f"   ⏳ Waiting {int(wait_seconds)} seconds for rate limit reset...")
                    time.sleep(wait_seconds + 1)
            
            return remaining
    except Exception as e:
        print(f"Could not check rate limit: {e}")
        return 0


def analyze_server_with_ai(name: str, description: str, github_info: Dict[str, Any], readme_content: Optional[str]) -> Dict[str, Any]:
    """Use AI to analyze the server and generate better metadata."""
    
    context = f"""
Analyze this Model Context Protocol (MCP) server and provide improved metadata.

Server name from Markdown: {name}
Description from Markdown: {description}
GitHub repository: https://github.com/{github_info.get('full_name', 'unknown')}
GitHub description: {github_info.get('description', 'No description')}
GitHub topics: {', '.join(github_info.get('topics', []))}
Primary language: {github_info.get('language', 'Unknown')}
Stars: {github_info.get('stars', 0)}

README excerpt (first 1000 chars):
{readme_content[:1000] if readme_content else 'No README available'}

Based on this information, provide:
1. A clear, concise display name (2-4 words, properly capitalized)
2. A one-line description (max 100 chars) explaining what this MCP server does
3. 5-10 relevant keywords/tags
4. 2-3 most relevant categories from: AI & ML, Development, Database, DevOps, Communication, File System, Web & API, Data Processing, Security, Monitoring, Cloud, Version Control, Testing, Documentation, Productivity, Automation, Analytics, Integration

Also identify package management information:
5. Package type (npm, pip, cargo, go, etc.) based on the language and any package files
6. Any environment variables or parameters that might be needed

Format your response EXACTLY like this:
NAME: [name here]
DESCRIPTION: [description here]
KEYWORDS: keyword1, keyword2, keyword3, keyword4, keyword5
CATEGORIES: Category1, Category2, Category3
PACKAGE_TYPE: [npm/pip/cargo/go/other]
ENV_VARS: VAR1, VAR2 (or "none" if not identified)
"""

    print(f"  🤖 Analyzing with AI ({OLLAMA_MODEL})...")
    response = analyze_with_ollama(context)
    
    if not response:
        return {}
    
    # Parse AI response
    result = {}
    lines = response.strip().split('\n')
    
    for line in lines:
        if line.startswith("NAME:"):
            result["display_name"] = line.replace("NAME:", "").strip()
        elif line.startswith("DESCRIPTION:"):
            result["ai_description"] = line.replace("DESCRIPTION:", "").strip()
        elif line.startswith("KEYWORDS:"):
            keywords = line.replace("KEYWORDS:", "").strip()
            result["keywords"] = [k.strip() for k in keywords.split(",") if k.strip()]
        elif line.startswith("CATEGORIES:"):
            categories = line.replace("CATEGORIES:", "").strip()
            result["categories"] = [c.strip() for c in categories.split(",") if c.strip()]
        elif line.startswith("PACKAGE_TYPE:"):
            result["package_type"] = line.replace("PACKAGE_TYPE:", "").strip().lower()
        elif line.startswith("ENV_VARS:"):
            env_vars = line.replace("ENV_VARS:", "").strip()
            if env_vars.lower() != "none":
                result["env_vars"] = [v.strip() for v in env_vars.split(",") if v.strip()]
    
    return result


def create_package_info(repo_url: str, package_json: Optional[Dict], ai_result: Dict, github_info: Dict) -> List[Dict]:
    """Create package information based on available data."""
    packages = []
    parsed = parse_github_url(repo_url)
    
    if not parsed:
        return packages
    
    # Determine package type and create package info
    if package_json and package_json.get("name"):
        # NPM package
        packages.append({
            "registry_name": "npm",
            "name": package_json.get("name"),
            "version": package_json.get("version", "latest"),
            "runtime_hint": "npx"
        })
    elif ai_result.get("package_type") == "pip" or (github_info.get("language") == "Python" and check_python_package(repo_url)):
        # Python package
        packages.append({
            "registry_name": "pypi",
            "name": f"{parsed['owner']}-{parsed['repo']}",
            "version": "latest",
            "runtime_hint": "uvx"
        })
    elif github_info.get("language") == "TypeScript" or github_info.get("language") == "JavaScript":
        # Likely a Node.js package even without package.json
        packages.append({
            "registry_name": "npm",
            "name": f"@{parsed['owner']}/{parsed['repo']}",
            "version": "latest",
            "runtime_hint": "npx"
        })
    elif github_info.get("language") == "Go":
        # Go module
        packages.append({
            "registry_name": "go",
            "name": f"github.com/{parsed['owner']}/{parsed['repo']}",
            "version": "latest",
            "runtime_hint": "go"
        })
    elif github_info.get("language") == "Rust":
        # Rust crate
        packages.append({
            "registry_name": "cargo",
            "name": parsed['repo'],
            "version": "latest",
            "runtime_hint": "cargo"
        })
    
    # Add environment variables if identified
    if ai_result.get("env_vars"):
        for package in packages:
            package["environment_variables"] = [
                {"name": var, "description": f"Environment variable for {var}"}
                for var in ai_result["env_vars"]
            ]
    
    return packages


def server_exists(conn: sqlite3.Connection, repo_url: str) -> bool:
    """Check if a server with the given repository URL already exists."""
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM servers WHERE repository_url = ?", (repo_url,))
    return cursor.fetchone() is not None


def get_or_create_id(conn: sqlite3.Connection, table: str, column: str, value: str) -> int:
    """Get existing ID or create new entry and return ID."""
    cursor = conn.cursor()
    
    # Try to get existing ID
    cursor.execute(f"SELECT id FROM {table} WHERE {column} = ?", (value,))
    result = cursor.fetchone()
    
    if result:
        return result[0]
    
    # Create new entry
    cursor.execute(f"INSERT INTO {table} ({column}) VALUES (?)", (value,))
    return cursor.lastrowid


def save_server_to_db(conn: sqlite3.Connection, server_data: Dict[str, Any]) -> bool:
    """Save server data to normalized SQLite database tables."""
    cursor = conn.cursor()
    
    try:
        # Start transaction
        conn.execute("BEGIN TRANSACTION")
        
        # Generate a unique ID if not provided
        server_id = server_data.get("id", str(uuid.uuid4()))
        
        # Insert into servers table
        cursor.execute("""
            INSERT OR REPLACE INTO servers (
                id, name, display_name, description, ai_description,
                repository_url, repository_source, repository_id,
                version, ai_analyzed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            server_id,
            server_data.get("name"),
            server_data.get("display_name"),
            server_data.get("description"),
            server_data.get("ai_description"),
            server_data.get("repository_url"),
            server_data.get("repository_source", "github"),
            server_data.get("repository_id"),
            server_data.get("version"),
            server_data.get("ai_analyzed_at")
        ))
        
        # Insert GitHub data
        if any(key.startswith("github_") for key in server_data):
            cursor.execute("""
                INSERT OR REPLACE INTO github_data (
                    server_id, stars, forks, watchers, open_issues,
                    language, license, homepage, description,
                    default_branch, archived, github_updated_at, github_created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                server_id,
                server_data.get("github_stars", 0),
                server_data.get("github_forks", 0),
                server_data.get("github_watchers", 0),
                server_data.get("github_open_issues", 0),
                server_data.get("github_language"),
                server_data.get("github_license"),
                server_data.get("github_homepage"),
                server_data.get("github_description"),
                server_data.get("github_default_branch"),
                server_data.get("github_archived", False),
                server_data.get("github_updated_at"),
                server_data.get("github_created_at")
            ))
        
        # Handle categories
        if "categories" in server_data and server_data["categories"]:
            # Clear existing categories
            cursor.execute("DELETE FROM server_categories WHERE server_id = ?", (server_id,))
            
            for category in server_data["categories"]:
                category_id = get_or_create_id(conn, "categories", "name", category)
                cursor.execute("""
                    INSERT OR IGNORE INTO server_categories (server_id, category_id)
                    VALUES (?, ?)
                """, (server_id, category_id))
        
        # Handle keywords
        if "keywords" in server_data and server_data["keywords"]:
            # Clear existing keywords
            cursor.execute("DELETE FROM server_keywords WHERE server_id = ?", (server_id,))
            
            for keyword in server_data["keywords"]:
                keyword_id = get_or_create_id(conn, "keywords", "keyword", keyword)
                cursor.execute("""
                    INSERT OR IGNORE INTO server_keywords (server_id, keyword_id)
                    VALUES (?, ?)
                """, (server_id, keyword_id))
        
        # Handle GitHub topics
        if "github_topics" in server_data and server_data["github_topics"]:
            # Clear existing topics
            cursor.execute("DELETE FROM server_github_topics WHERE server_id = ?", (server_id,))
            
            for topic in server_data["github_topics"]:
                topic_id = get_or_create_id(conn, "github_topics", "topic", topic)
                cursor.execute("""
                    INSERT OR IGNORE INTO server_github_topics (server_id, topic_id)
                    VALUES (?, ?)
                """, (server_id, topic_id))
        
        # Handle packages
        if "packages" in server_data and server_data["packages"]:
            # Clear existing packages
            cursor.execute("DELETE FROM packages WHERE server_id = ?", (server_id,))
            
            for package in server_data["packages"]:
                cursor.execute("""
                    INSERT INTO packages (
                        server_id, registry_name, package_name, version, runtime_hint
                    ) VALUES (?, ?, ?, ?, ?)
                """, (
                    server_id,
                    package.get("registry_name"),
                    package.get("name"),
                    package.get("version"),
                    package.get("runtime_hint")
                ))
                package_id = cursor.lastrowid
                
                # Handle environment variables for this package
                if "environment_variables" in package:
                    for env_var in package["environment_variables"]:
                        cursor.execute("""
                            INSERT INTO environment_variables (
                                package_id, name, description, is_required, is_secret
                            ) VALUES (?, ?, ?, ?, ?)
                        """, (
                            package_id,
                            env_var.get("name"),
                            env_var.get("description"),
                            env_var.get("is_required", False),
                            env_var.get("is_secret", False)
                        ))
        
        # Commit transaction
        conn.commit()
        return True
        
    except Exception as e:
        print(f"  ✗ Database error: {e}")
        conn.rollback()
        return False


def parse_servers_md(filepath: str) -> List[Tuple[int, str, str]]:
    """Parse servers.md file and extract GitHub links with descriptions."""
    servers = []
    
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        # Skip legend section
        in_legend = True
        for i, line in enumerate(lines):
            if in_legend:
                if line.startswith("## Server Implementations") or line.startswith("### "):
                    in_legend = False
                continue
            
            # Look for lines with GitHub links
            if "github.com" in line and line.strip().startswith("-"):
                # Extract the full line content
                content = line.strip()
                if content.startswith("- "):
                    content = content[2:].strip()
                
                # Try to extract the GitHub URL
                github_match = re.search(r'(https://github\.com/[^/\s]+/[^/\s\)]+)', line)
                if not github_match:
                    # Try to extract from markdown link format
                    github_match = re.search(r'\[([^\]]+)\]\((https://github\.com/[^)]+)\)', line)
                    if github_match:
                        url = github_match.group(2)
                        name = github_match.group(1)
                    else:
                        continue
                else:
                    url = github_match.group(1)
                    # Extract name from markdown or use URL
                    name_match = re.search(r'\[([^\]]+)\]', line)
                    if name_match:
                        name = name_match.group(1)
                    else:
                        parsed = parse_github_url(url)
                        if parsed:
                            name = f"{parsed['owner']}/{parsed['repo']}"
                        else:
                            name = url
                
                # Extract description (everything after the URL/link)
                desc_parts = line.split(" - ", 1)
                if len(desc_parts) > 1:
                    description = desc_parts[1].strip()
                else:
                    description = ""
                
                servers.append((i + 1, url, description))
        
    except Exception as e:
        print(f"❌ Error reading {filepath}: {e}")
        return []
    
    return servers


def enrich_servers_from_md(use_ai: bool = True):
    """Main function to enrich servers from servers.md file."""
    print(f"📚 Loading servers from {SERVERS_MD_PATH}...")
    
    # Parse servers.md
    servers = parse_servers_md(SERVERS_MD_PATH)
    if not servers:
        print("❌ No servers found in servers.md")
        return
    
    print(f"✓ Found {len(servers)} servers with GitHub links")
    
    # Initialize database
    conn = init_database()
    
    # Check Ollama if AI analysis is enabled
    if use_ai:
        print(f"\n🤖 Checking Ollama server with {OLLAMA_MODEL} model...")
        if not check_ollama_server():
            print("⚠️  Ollama not available. Continuing without AI analysis.")
            print("   To enable AI analysis:")
            print("   1. Install Ollama: https://ollama.ai")
            print(f"   2. Pull the model: ollama pull {OLLAMA_MODEL}")
            print("   3. Start Ollama: ollama serve")
            use_ai = False
        else:
            print(f"✓ Ollama server ready with {OLLAMA_MODEL}")
    
    # Check initial rate limit
    remaining = check_rate_limit()
    if remaining == 0:
        print("⚠️  No API calls remaining. Please wait or set GITHUB_TOKEN environment variable.")
        return
    
    # Process each server
    enriched_count = 0
    skipped_count = 0
    failed_count = 0
    
    for i, (line_num, repo_url, description) in enumerate(servers, 1):
        # Parse name from URL
        parsed = parse_github_url(repo_url)
        if not parsed:
            print(f"\n[{i}/{len(servers)}] ⚠️ Could not parse URL: {repo_url}")
            failed_count += 1
            continue
        
        server_name = f"{parsed['owner']}/{parsed['repo']}"
        
        print(f"\n[{i}/{len(servers)}] Processing: {server_name}")
        print(f"  Line {line_num}: {description[:60]}..." if description else f"  Line {line_num}")
        
        # Check if already processed
        if server_exists(conn, repo_url):
            print(f"  ⏭️  Already in database, skipping")
            skipped_count += 1
            continue
        
        # Fetch GitHub data
        print(f"  🔍 Fetching from GitHub...")
        github_info = fetch_github_info(repo_url)
        
        if not github_info:
            failed_count += 1
            continue
        
        print(f"  ✓ Stars: {github_info['stars']:,} | Forks: {github_info['forks']:,} | Language: {github_info.get('language', 'N/A')}")
        
        # Prepare server data
        server_data = {
            "id": str(uuid.uuid4()),
            "name": server_name,
            "description": description or github_info.get("description", ""),
            "repository_url": repo_url,
            "repository_source": "github",
            "repository_id": str(uuid.uuid4()),
            "github_stars": github_info["stars"],
            "github_forks": github_info["forks"],
            "github_watchers": github_info["watchers"],
            "github_open_issues": github_info["open_issues"],
            "github_language": github_info["language"],
            "github_license": github_info["license"],
            "github_topics": github_info["topics"],
            "github_description": github_info.get("description"),
            "github_default_branch": github_info.get("default_branch", "main"),
            "github_updated_at": github_info["updated_at"],
            "github_created_at": github_info["created_at"],
            "github_archived": github_info["archived"],
            "github_homepage": github_info["homepage"]
        }
        
        # Fetch package.json if available
        package_json = fetch_package_json(repo_url)
        
        # AI Analysis
        if use_ai:
            readme_content = fetch_readme_content(repo_url)
            ai_result = analyze_server_with_ai(server_name, description, github_info, readme_content)
            
            if ai_result:
                if ai_result.get("display_name"):
                    server_data["display_name"] = ai_result["display_name"]
                    print(f"  📝 AI Name: {ai_result['display_name']}")
                
                if ai_result.get("ai_description"):
                    server_data["ai_description"] = ai_result["ai_description"]
                    print(f"  📝 AI Description: {ai_result['ai_description'][:60]}...")
                
                if ai_result.get("keywords"):
                    server_data["keywords"] = ai_result["keywords"]
                    print(f"  🏷️  Keywords: {', '.join(ai_result['keywords'][:5])}")
                
                if ai_result.get("categories"):
                    server_data["categories"] = ai_result["categories"]
                    print(f"  📁 Categories: {', '.join(ai_result['categories'])}")
                
                server_data["ai_analyzed_at"] = datetime.now().isoformat()
                
                # Create package info
                packages = create_package_info(repo_url, package_json, ai_result, github_info)
                if packages:
                    server_data["packages"] = packages
                    print(f"  📦 Package: {packages[0]['registry_name']}")
        
        # Save to database
        if save_server_to_db(conn, server_data):
            print(f"  ✅ Saved to database")
            enriched_count += 1
        else:
            print(f"  ❌ Failed to save to database")
            failed_count += 1
        
        # Rate limiting
        if not GITHUB_TOKEN and i % 10 == 0:
            print(f"\n⏸️  Pausing to respect rate limits...")
            time.sleep(2)
        elif GITHUB_TOKEN and i % 50 == 0:
            check_rate_limit()
    
    # Close database
    conn.close()
    
    # Summary
    print(f"\n📊 Summary:")
    print(f"   ✓ Enriched and saved: {enriched_count}")
    print(f"   ⏭️  Skipped (already in DB): {skipped_count}")
    print(f"   ✗ Failed: {failed_count}")
    print(f"   Total processed: {len(servers)}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Enrich MCP servers from servers.md with GitHub info and AI analysis")
    parser.add_argument("--no-ai", action="store_true", help="Skip AI analysis")
    parser.add_argument("--model", default="qwen3:30b", help="Ollama model to use")
    parser.add_argument("--db", default="database/servers.db", help="Database file path")
    parser.add_argument("--md", default="scripts/servers.md", help="servers.md file path")
    
    args = parser.parse_args()
    
    # Update configuration
    if args.model:
        OLLAMA_MODEL = args.model
    if args.db:
        DATABASE_PATH = args.db
    if args.md:
        SERVERS_MD_PATH = args.md
    
    print("🚀 MCP Server Data Enrichment from servers.md")
    print("=" * 50)
    
    if not GITHUB_TOKEN:
        print("💡 Tip: Set GITHUB_TOKEN environment variable for higher rate limits")
        print("   export GITHUB_TOKEN=your_github_personal_access_token")
        print()
    
    enrich_servers_from_md(use_ai=not args.no_ai)
    print("\n✨ Done!")