-- MCP Server Catalogue Database Schema
-- SQLite database for browser-based storage using sql.js

-- Main servers table
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

-- GitHub metadata table
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

-- Packages table (npm, pypi, docker, etc.)
CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    registry_name TEXT NOT NULL,
    package_name TEXT NOT NULL,
    version TEXT,
    runtime_hint TEXT,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- Environment variables table
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

-- Package arguments table
CREATE TABLE IF NOT EXISTS package_arguments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL,
    type TEXT, -- 'named' or 'positional'
    name TEXT,
    value TEXT,
    value_hint TEXT,
    description TEXT,
    is_required BOOLEAN DEFAULT 0,
    default_value TEXT,
    format TEXT,
    FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

-- Server categories junction table
CREATE TABLE IF NOT EXISTS server_categories (
    server_id TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (server_id, category_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- Keywords/tags table
CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL
);

-- Server keywords junction table
CREATE TABLE IF NOT EXISTS server_keywords (
    server_id TEXT NOT NULL,
    keyword_id INTEGER NOT NULL,
    PRIMARY KEY (server_id, keyword_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
);

-- GitHub topics table
CREATE TABLE IF NOT EXISTS github_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT UNIQUE NOT NULL
);

-- Server GitHub topics junction table
CREATE TABLE IF NOT EXISTS server_github_topics (
    server_id TEXT NOT NULL,
    topic_id INTEGER NOT NULL,
    PRIMARY KEY (server_id, topic_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES github_topics(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_servers_name ON servers(name);
CREATE INDEX IF NOT EXISTS idx_servers_display_name ON servers(display_name);
CREATE INDEX IF NOT EXISTS idx_packages_server_id ON packages(server_id);
CREATE INDEX IF NOT EXISTS idx_packages_registry ON packages(registry_name);
CREATE INDEX IF NOT EXISTS idx_env_vars_package_id ON environment_variables(package_id);
CREATE INDEX IF NOT EXISTS idx_env_vars_is_secret ON environment_variables(is_secret);
CREATE INDEX IF NOT EXISTS idx_github_stars ON github_data(stars DESC);
CREATE INDEX IF NOT EXISTS idx_server_categories ON server_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_server_keywords ON server_keywords(keyword_id);

-- Full-text search virtual table for server search
CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
    name,
    display_name,
    description,
    ai_description,
    keywords,
    tokenize = 'porter unicode61'
);

-- Views for easier querying
CREATE VIEW IF NOT EXISTS server_list AS
SELECT 
    s.id,
    s.name,
    s.display_name,
    s.description,
    s.ai_description,
    s.repository_url,
    s.version,
    g.stars,
    g.forks,
    g.language,
    g.license,
    GROUP_CONCAT(DISTINCT c.name) as categories,
    GROUP_CONCAT(DISTINCT k.keyword) as keywords_list,
    COUNT(DISTINCT p.id) as package_count
FROM servers s
LEFT JOIN github_data g ON s.id = g.server_id
LEFT JOIN packages p ON s.id = p.server_id
LEFT JOIN server_categories sc ON s.id = sc.server_id
LEFT JOIN categories c ON sc.category_id = c.id
LEFT JOIN server_keywords sk ON s.id = sk.server_id
LEFT JOIN keywords k ON sk.keyword_id = k.id
GROUP BY s.id;

-- View for server details with all packages
CREATE VIEW IF NOT EXISTS server_with_packages AS
SELECT 
    s.*,
    p.id as package_id,
    p.registry_name,
    p.package_name,
    p.version as package_version,
    p.runtime_hint
FROM servers s
LEFT JOIN packages p ON s.id = p.server_id;

-- View for packages with environment variables
CREATE VIEW IF NOT EXISTS package_env_vars AS
SELECT 
    p.id as package_id,
    p.server_id,
    p.registry_name,
    p.package_name,
    ev.name as env_var_name,
    ev.description as env_var_description,
    ev.is_required,
    ev.is_secret,
    ev.default_value
FROM packages p
LEFT JOIN environment_variables ev ON p.id = ev.package_id;