// Database module using sql.js for browser-based SQLite
// This module handles all database operations for the MCP Bundler

class MCPDatabase {
    constructor() {
        this.db = null;
        this.SQL = null;
        this.dbReady = false;
        this.initPromise = null;
    }

    // Initialize sql.js and load the database
    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this._initInternal();
        return this.initPromise;
    }

    async _initInternal() {
        if (this.dbReady) {
            return;
        }

        console.log('Initializing SQLite database...');

        try {
            // Initialize sql.js
            this.SQL = await initSqlJs({
                locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/${file}`
            });

            // Load the database file
            const response = await fetch('/database/servers.db');
            if (!response.ok) {
                throw new Error(`Failed to load database: ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            const uint8Array = new Uint8Array(buffer);
            
            // Create database from the loaded file
            this.db = new this.SQL.Database(uint8Array);
            this.dbReady = true;

            console.log('✓ Database loaded successfully');
            
            // Test query
            const count = this.db.exec("SELECT COUNT(*) as count FROM servers")[0].values[0][0];
            console.log(`✓ Database contains ${count} servers`);

        } catch (error) {
            console.error('Failed to initialize database:', error);
            throw error;
        }
    }

    // Ensure database is ready before operations
    async ensureReady() {
        if (!this.dbReady) {
            await this.init();
        }
    }

    // Get all servers with basic info
    async getServers(limit = 1000, offset = 0) {
        await this.ensureReady();

        const query = `
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
                GROUP_CONCAT(DISTINCT c.name) as categories,
                GROUP_CONCAT(DISTINCT k.keyword) as keywords,
                COALESCE(MAX(CASE WHEN ev.is_secret = 1 THEN 1 ELSE 0 END), 0) as has_secrets
            FROM servers s
            LEFT JOIN github_data g ON s.id = g.server_id
            LEFT JOIN server_categories sc ON s.id = sc.server_id
            LEFT JOIN categories c ON sc.category_id = c.id
            LEFT JOIN server_keywords sk ON s.id = sk.server_id
            LEFT JOIN keywords k ON sk.keyword_id = k.id
            LEFT JOIN packages p ON s.id = p.server_id
            LEFT JOIN environment_variables ev ON p.id = ev.package_id
            WHERE s.ai_deleted = 0
            GROUP BY s.id
            ORDER BY g.stars DESC
            LIMIT ? OFFSET ?
        `;

        const result = this.db.exec(query, [limit, offset]);
        const servers = this.resultToObjects(result[0]);
        
        // For servers with secrets, load a simplified package structure
        for (const server of servers) {
            if (server.has_secrets) {
                // Create a minimal package structure for credential checking
                server.packages = [{
                    environment_variables: [{
                        is_secret: true,
                        is_required: true
                    }]
                }];
            } else {
                server.packages = [];
            }
        }
        
        return servers;
    }

    // Search servers using full-text search
    async searchServers(searchQuery, limit = 100) {
        await this.ensureReady();

        if (!searchQuery || searchQuery.trim() === '') {
            return this.getServers(limit);
        }

        // Prepare search query for FTS5
        const ftsQuery = searchQuery.trim().split(/\s+/)
            .map(term => `"${term}"*`)
            .join(' OR ');

        const query = `
            SELECT DISTINCT
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
                GROUP_CONCAT(DISTINCT c.name) as categories,
                GROUP_CONCAT(DISTINCT k.keyword) as keywords,
                COALESCE(MAX(CASE WHEN ev.is_secret = 1 THEN 1 ELSE 0 END), 0) as has_secrets
            FROM servers_fts fts
            JOIN servers s ON s.name = fts.name
            LEFT JOIN github_data g ON s.id = g.server_id
            LEFT JOIN server_categories sc ON s.id = sc.server_id
            LEFT JOIN categories c ON sc.category_id = c.id
            LEFT JOIN server_keywords sk ON s.id = sk.server_id
            LEFT JOIN keywords k ON sk.keyword_id = k.id
            LEFT JOIN packages p ON s.id = p.server_id
            LEFT JOIN environment_variables ev ON p.id = ev.package_id
            WHERE servers_fts MATCH ? AND s.ai_deleted = 0
            GROUP BY s.id
            ORDER BY rank, g.stars DESC
            LIMIT ?
        `;

        try {
            const result = this.db.exec(query, [ftsQuery, limit]);
            if (!result || result.length === 0) {
                return [];
            }
            const servers = this.resultToObjects(result[0]);
            
            // For servers with secrets, load a simplified package structure
            for (const server of servers) {
                if (server.has_secrets) {
                    server.packages = [{
                        environment_variables: [{
                            is_secret: true,
                            is_required: true
                        }]
                    }];
                } else {
                    server.packages = [];
                }
            }
            
            return servers;
        } catch (error) {
            console.warn('FTS search failed, falling back to LIKE search:', error);
            return this.searchServersLike(searchQuery, limit);
        }
    }

    // Fallback search using LIKE
    async searchServersLike(searchQuery, limit = 100) {
        await this.ensureReady();

        const likeQuery = `%${searchQuery}%`;

        const query = `
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
                GROUP_CONCAT(DISTINCT c.name) as categories,
                GROUP_CONCAT(DISTINCT k.keyword) as keywords,
                COALESCE(MAX(CASE WHEN ev.is_secret = 1 THEN 1 ELSE 0 END), 0) as has_secrets
            FROM servers s
            LEFT JOIN github_data g ON s.id = g.server_id
            LEFT JOIN server_categories sc ON s.id = sc.server_id
            LEFT JOIN categories c ON sc.category_id = c.id
            LEFT JOIN server_keywords sk ON s.id = sk.server_id
            LEFT JOIN keywords k ON sk.keyword_id = k.id
            LEFT JOIN packages p ON s.id = p.server_id
            LEFT JOIN environment_variables ev ON p.id = ev.package_id
            WHERE s.ai_deleted = 0 AND (
                s.name LIKE ? 
               OR s.display_name LIKE ?
               OR s.description LIKE ?
               OR s.ai_description LIKE ?
            )
            GROUP BY s.id
            ORDER BY g.stars DESC
            LIMIT ?
        `;

        const result = this.db.exec(query, [likeQuery, likeQuery, likeQuery, likeQuery, limit]);
        if (!result || result.length === 0) {
            return [];
        }
        const servers = this.resultToObjects(result[0]);
        
        // For servers with secrets, load a simplified package structure
        for (const server of servers) {
            if (server.has_secrets) {
                server.packages = [{
                    environment_variables: [{
                        is_secret: true,
                        is_required: true
                    }]
                }];
            } else {
                server.packages = [];
            }
        }
        
        return servers;
    }

    // Get server by ID with all details
    async getServerById(serverId) {
        await this.ensureReady();

        const query = `
            SELECT 
                s.*,
                g.stars,
                g.forks,
                g.watchers,
                g.open_issues,
                g.language,
                g.license,
                g.homepage,
                g.archived,
                g.github_updated_at,
                GROUP_CONCAT(DISTINCT c.name) as categories,
                GROUP_CONCAT(DISTINCT k.keyword) as keywords,
                GROUP_CONCAT(DISTINCT gt.topic) as github_topics
            FROM servers s
            LEFT JOIN github_data g ON s.id = g.server_id
            LEFT JOIN server_categories sc ON s.id = sc.server_id
            LEFT JOIN categories c ON sc.category_id = c.id
            LEFT JOIN server_keywords sk ON s.id = sk.server_id
            LEFT JOIN keywords k ON sk.keyword_id = k.id
            LEFT JOIN server_github_topics sgt ON s.id = sgt.server_id
            LEFT JOIN github_topics gt ON sgt.topic_id = gt.id
            WHERE s.id = ? AND s.ai_deleted = 0
            GROUP BY s.id
        `;

        const result = this.db.exec(query, [serverId]);
        if (!result || result.length === 0) {
            return null;
        }

        const server = this.resultToObjects(result[0])[0];
        
        // Get packages for this server
        server.packages = await this.getServerPackages(serverId);
        
        return server;
    }

    // Get packages for a server
    async getServerPackages(serverId) {
        await this.ensureReady();

        // First get packages
        const packagesQuery = `
            SELECT id, server_id, registry_name, package_name, version, runtime_hint
            FROM packages
            WHERE server_id = ?
        `;

        const packagesResult = this.db.exec(packagesQuery, [serverId]);
        if (!packagesResult || packagesResult.length === 0) {
            return [];
        }

        const packages = this.resultToObjects(packagesResult[0]);
        
        // For each package, get its environment variables and arguments
        packages.forEach(pkg => {
            // Get environment variables for this package
            const envVarsQuery = `
                SELECT name, description, is_required, is_secret, default_value, format
                FROM environment_variables
                WHERE package_id = ?
            `;
            
            const envResult = this.db.exec(envVarsQuery, [pkg.id]);
            if (envResult && envResult.length > 0) {
                pkg.environment_variables = this.resultToObjects(envResult[0]);
            } else {
                pkg.environment_variables = [];
            }
            
            // Get package arguments for this package
            const argsQuery = `
                SELECT type, name, value, value_hint, description, is_required, default_value, format
                FROM package_arguments
                WHERE package_id = ?
            `;
            
            const argsResult = this.db.exec(argsQuery, [pkg.id]);
            if (argsResult && argsResult.length > 0) {
                pkg.package_arguments = this.resultToObjects(argsResult[0]);
            } else {
                pkg.package_arguments = [];
            }
        });

        return packages;
    }

    // Get environment variables for a specific package
    async getPackageEnvironmentVariables(packageId) {
        await this.ensureReady();

        const query = `
            SELECT name, description, is_required, is_secret, default_value, format
            FROM environment_variables
            WHERE package_id = ?
            ORDER BY is_required DESC, name ASC
        `;

        const result = this.db.exec(query, [packageId]);
        if (!result || result.length === 0) {
            return [];
        }
        
        return this.resultToObjects(result[0]);
    }

    // Get servers by category
    async getServersByCategory(categoryName, limit = 100) {
        await this.ensureReady();

        const query = `
            SELECT 
                s.id,
                s.name,
                s.display_name,
                s.description,
                s.ai_description,
                s.repository_url,
                g.stars,
                g.forks,
                GROUP_CONCAT(DISTINCT c.name) as categories
            FROM servers s
            JOIN server_categories sc ON s.id = sc.server_id
            JOIN categories c ON sc.category_id = c.id
            LEFT JOIN github_data g ON s.id = g.server_id
            WHERE c.name = ? AND s.ai_deleted = 0
            GROUP BY s.id
            ORDER BY g.stars DESC
            LIMIT ?
        `;

        const result = this.db.exec(query, [categoryName, limit]);
        if (!result || result.length === 0) {
            return [];
        }
        return this.resultToObjects(result[0]);
    }

    // Get all categories with server counts
    async getCategories() {
        await this.ensureReady();

        const query = `
            SELECT 
                c.name,
                COUNT(DISTINCT CASE WHEN s.ai_deleted = 0 THEN sc.server_id END) as server_count
            FROM categories c
            LEFT JOIN server_categories sc ON c.id = sc.category_id
            LEFT JOIN servers s ON sc.server_id = s.id
            GROUP BY c.id
            ORDER BY server_count DESC
        `;

        const result = this.db.exec(query);
        if (!result || result.length === 0) {
            return [];
        }
        return this.resultToObjects(result[0]);
    }

    // Get servers that need credentials
    async getServersNeedingCredentials() {
        await this.ensureReady();

        const query = `
            SELECT DISTINCT
                s.id,
                s.name,
                s.display_name,
                s.description,
                s.repository_url
            FROM servers s
            JOIN packages p ON s.id = p.server_id
            JOIN environment_variables ev ON p.id = ev.package_id
            WHERE ev.is_secret = 1 AND s.ai_deleted = 0
            ORDER BY s.display_name
        `;

        const result = this.db.exec(query);
        if (!result || result.length === 0) {
            return [];
        }
        return this.resultToObjects(result[0]);
    }

    // Convert SQLite result to array of objects
    resultToObjects(result) {
        if (!result) return [];
        
        const { columns, values } = result;
        return values.map(row => {
            const obj = {};
            columns.forEach((col, i) => {
                let value = row[i];
                
                // Parse split fields
                if (col === 'categories' && value) {
                    value = value.split(',').filter(v => v);
                } else if (col === 'keywords' && value) {
                    value = value.split(',').filter(v => v);
                } else if (col === 'github_topics' && value) {
                    value = value.split(',').filter(v => v);
                }
                
                obj[col] = value;
            });
            return obj;
        });
    }

    // Get database statistics
    async getStats() {
        await this.ensureReady();

        const query = `
            SELECT 
                (SELECT COUNT(*) FROM servers WHERE ai_deleted = 0) as total_servers,
                (SELECT COUNT(*) FROM packages p JOIN servers s ON p.server_id = s.id WHERE s.ai_deleted = 0) as total_packages,
                (SELECT COUNT(*) FROM categories) as total_categories,
                (SELECT COUNT(*) FROM keywords) as total_keywords,
                (SELECT COUNT(*) FROM github_topics) as total_topics,
                (SELECT COUNT(DISTINCT g.server_id) FROM github_data g JOIN servers s ON g.server_id = s.id WHERE g.stars > 100 AND s.ai_deleted = 0) as popular_servers,
                (SELECT SUM(g.stars) FROM github_data g JOIN servers s ON g.server_id = s.id WHERE s.ai_deleted = 0) as total_stars
        `;

        const result = this.db.exec(query);
        if (!result || result.length === 0) {
            return {};
        }
        return this.resultToObjects(result[0])[0];
    }

    // Close the database
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.dbReady = false;
        }
    }
}

// Create and export singleton instance
const database = new MCPDatabase();
export default database;