// Alpine.js Stores for persistent state management
// Following Section 8.3 - Alpine.js Component Architecture

// Storage keys as defined in Section 4.1
const STORAGE_KEYS = {
  bundles: 'mcp-catalogue:v1:bundles',
  connections: 'mcp-catalogue:v1:connections',
  credentials: 'mcp-catalogue:v1:credentials', 
  settings: 'mcp-catalogue:v1:settings',
  cache: 'mcp-catalogue:v1:cache'
};

// Utility functions for localStorage management
const storage = {
  get(key) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error('Failed to get from localStorage:', error);
      return null;
    }
  },
  
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('Failed to save to localStorage:', error);
      return false;
    }
  },
  
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.error('Failed to remove from localStorage:', error);
      return false;
    }
  },
  
  clear() {
    try {
      // Only clear our app's keys
      Object.values(STORAGE_KEYS).forEach(key => {
        localStorage.removeItem(key);
      });
      return true;
    } catch (error) {
      console.error('Failed to clear localStorage:', error);
      return false;
    }
  }
};

// Debounced save function (500ms delay as per Section 4.2)
let saveTimeouts = {};
const debouncedSave = (key, data, delay = 500) => {
  if (saveTimeouts[key]) {
    clearTimeout(saveTimeouts[key]);
  }
  
  saveTimeouts[key] = setTimeout(() => {
    storage.set(key, data);
    delete saveTimeouts[key];
  }, delay);
};

// Bundle Store - Section 3.2 User Bundle Schema
document.addEventListener('alpine:init', () => {
  Alpine.store('bundles', {
    items: storage.get(STORAGE_KEYS.bundles) || [],
    
    // Create new bundle
    create(name, description = '') {
      const bundle = {
        id: Date.now().toString(),
        name: name.trim(),
        description: description.trim(),
        servers: [], // Back to servers array
        serverConnections: {}, // Maps serverId to connectionId
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        metadata: {
          tags: []
        }
      };
      
      this.items.push(bundle);
      this.save();
      
      console.log('Bundle created:', bundle.name);
      return bundle;
    },
    
    // Update existing bundle
    update(bundleId, updates) {
      const index = this.items.findIndex(b => b.id === bundleId);
      if (index === -1) return null;
      
      const bundle = this.items[index];
      Object.assign(bundle, updates, {
        updated: new Date().toISOString()
      });
      
      
      this.save();
      console.log('Bundle updated:', bundle.name);
      return bundle;
    },
    
    // Delete bundle
    delete(bundleId) {
      const index = this.items.findIndex(b => b.id === bundleId);
      if (index === -1) return false;
      
      const bundle = this.items[index];
      this.items.splice(index, 1);
      
      
      this.save();
      console.log('Bundle deleted:', bundle.name);
      return true;
    },
    
    // Get bundle by ID
    getById(bundleId) {
      return this.items.find(b => b.id === bundleId) || null;
    },
    
    // Save to localStorage with debouncing
    save() {
      debouncedSave(STORAGE_KEYS.bundles, this.items);
    },
    
    // Export all bundles for backup
    exportAll() {
      return {
        version: '1.0',
        exported: new Date().toISOString(),
        bundles: this.items
      };
    },
    
    // Import bundles from backup
    importAll(data) {
      if (!data.bundles || !Array.isArray(data.bundles)) {
        throw new Error('Invalid import data');
      }
      
      this.items = data.bundles;
      this.save();
      console.log('Bundles imported:', data.bundles.length);
    },

    // Add server to bundle
    addServer(bundleId, serverId, packageIndex = 0) {
      const bundle = this.getById(bundleId);
      if (!bundle) {
        throw new Error('Bundle not found');
      }
      
      // Initialize servers array if needed
      if (!bundle.servers) {
        bundle.servers = [];
      }
      
      // Check if server already exists
      const existing = bundle.servers.find(s => 
        (typeof s === 'string' && s === serverId) ||
        (typeof s === 'object' && s.serverId === serverId)
      );
      
      if (!existing) {
        // Add as new format object
        bundle.servers.push({
          serverId: serverId,
          packageIndex: packageIndex,
          connectionId: null
        });
        bundle.updated = new Date().toISOString();
        this.save();
      }
      
      return bundle;
    },

    // Remove server from bundle
    removeServer(bundleId, serverId) {
      const bundle = this.getById(bundleId);
      if (!bundle) {
        throw new Error('Bundle not found');
      }
      
      if (!bundle.servers) return bundle;
      
      // Find index handling both old and new format
      const index = bundle.servers.findIndex(s => 
        (typeof s === 'string' && s === serverId) ||
        (typeof s === 'object' && s.serverId === serverId)
      );
      
      if (index > -1) {
        bundle.servers.splice(index, 1);
        // Also remove any attached connection for this server
        if (bundle.serverConnections && bundle.serverConnections[serverId]) {
          delete bundle.serverConnections[serverId];
        }
        bundle.updated = new Date().toISOString();
        this.save();
      }
      
      return bundle;
    },

    // Attach connection to server in bundle
    attachConnection(bundleId, serverId, connectionId) {
      const bundle = this.getById(bundleId);
      if (!bundle) {
        throw new Error('Bundle not found');
      }
      
      // Check if server exists in bundle (handle both formats)
      const serverExists = bundle.servers && bundle.servers.some(s => 
        (typeof s === 'string' && s === serverId) ||
        (typeof s === 'object' && s.serverId === serverId)
      );
      
      if (!serverExists) {
        throw new Error('Server not in bundle');
      }
      
      if (!bundle.serverConnections) {
        bundle.serverConnections = {};
      }
      
      bundle.serverConnections[serverId] = connectionId;
      bundle.updated = new Date().toISOString();
      this.save();
      
      return bundle;
    },

    // Detach connection from server in bundle
    detachConnection(bundleId, serverId) {
      const bundle = this.getById(bundleId);
      if (!bundle) {
        throw new Error('Bundle not found');
      }
      
      if (bundle.serverConnections && bundle.serverConnections[serverId]) {
        delete bundle.serverConnections[serverId];
        bundle.updated = new Date().toISOString();
        this.save();
      }
      
      return bundle;
    },

    // Get attached connection for server in bundle
    getServerConnection(bundleId, serverId) {
      const bundle = this.getById(bundleId);
      if (!bundle || !bundle.serverConnections) return null;
      
      const connectionId = bundle.serverConnections[serverId];
      return connectionId ? Alpine.store('connections').get(connectionId) : null;
    },

    // Check if server has attached connection in bundle
    hasServerConnection(bundleId, serverId) {
      const bundle = this.getById(bundleId);
      return bundle && bundle.serverConnections && !!bundle.serverConnections[serverId];
    }
  });

  // Connections Store - Named MCP Server Connections with Credentials
  Alpine.store('connections', {
    items: [],
    
    init() {
      this.load();
    },
    
    load() {
      const data = storage.get(STORAGE_KEYS.connections);
      this.items = data ? data.connections || [] : [];
      console.log('Connections loaded:', this.items.length);
    },
    
    save() {
      const data = {
        connections: this.items,
        version: '1.0.0',
        updated: new Date().toISOString()
      };
      
      if (storage.set(STORAGE_KEYS.connections, data)) {
        console.log('Connections saved');
      } else {
        console.error('Failed to save connections');
      }
    },
    
    // Create a new connection
    create(name, serverId, packageId, credentials = {}) {
      const connection = {
        id: 'conn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name.trim(),
        serverId: serverId,
        packageId: packageId, // Now connections are per-package
        credentials: credentials, // Environment variables for this package
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      };
      
      this.items.push(connection);
      this.save();
      return connection;
    },
    
    // Update a connection
    update(connectionId, updates) {
      const connection = this.items.find(c => c.id === connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }
      
      Object.assign(connection, updates, {
        updated: new Date().toISOString()
      });
      
      this.save();
      return connection;
    },
    
    // Delete a connection
    delete(connectionId) {
      const index = this.items.findIndex(c => c.id === connectionId);
      if (index === -1) {
        throw new Error('Connection not found');
      }
      
      // Check if connection is used in any bundles
      const bundles = Alpine.store('bundles').items;
      const isUsed = bundles.some(bundle => 
        bundle.connections && bundle.connections.includes(connectionId)
      );
      
      if (isUsed) {
        throw new Error('Cannot delete connection - it is used in one or more bundles');
      }
      
      this.items.splice(index, 1);
      this.save();
      return true;
    },
    
    // Get connection by ID
    get(connectionId) {
      return this.items.find(c => c.id === connectionId);
    },
    
    // Get connections for a specific server type
    getByServerId(serverId) {
      return this.items.filter(c => c.serverId === serverId);
    },
    
    // Get connections for a specific package
    getByPackageId(packageId) {
      return this.items.filter(c => c.packageId === packageId);
    },
    
    // Get connection for specific server and package
    getByServerAndPackage(serverId, packageId) {
      return this.items.find(c => c.serverId === serverId && c.packageId === packageId);
    },
    
    // Update connection credentials (all at once)
    updateCredentials(connectionId, credentials) {
      const connection = this.get(connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }
      
      connection.credentials = credentials;
      connection.updated = new Date().toISOString();
      this.save();
      return connection;
    },
    
    // Set a single credential within a connection
    setCredential(connectionId, secretName, value) {
      const connection = this.get(connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }
      
      if (!connection.credentials) {
        connection.credentials = {};
      }
      
      connection.credentials[secretName] = value;
      connection.updated = new Date().toISOString();
      this.save();
      return connection;
    },
    
    // Remove a single credential from a connection
    removeCredential(connectionId, secretName) {
      const connection = this.get(connectionId);
      if (!connection) {
        throw new Error('Connection not found');
      }
      
      if (connection.credentials && connection.credentials[secretName]) {
        delete connection.credentials[secretName];
        connection.updated = new Date().toISOString();
        this.save();
      }
      
      return connection;
    },
    
    // Check if connection has all required credentials for its package
    hasRequiredCredentials(connectionId, packageData = null) {
      const connection = this.get(connectionId);
      if (!connection) return false;
      
      // If no package data provided, we'll need to get it from the database
      // For now, just check if connection has any credentials
      if (!connection.credentials) return false;
      
      // If package data is provided, check required environment variables
      if (packageData && packageData.environment_variables) {
        const requiredVars = packageData.environment_variables.filter(env => env.is_required);
        return requiredVars.every(envVar => 
          connection.credentials[envVar.name] && 
          connection.credentials[envVar.name].trim()
        );
      }
      
      // If no package data, just check if any credentials exist
      return Object.keys(connection.credentials).length > 0;
    },
    
    // Get missing credentials for a connection
    getMissingCredentials(connectionId, packageData = null) {
      const connection = this.get(connectionId);
      if (!connection) return [];
      
      if (!packageData || !packageData.environment_variables) return [];
      
      const requiredVars = packageData.environment_variables.filter(env => env.is_required);
      return requiredVars.filter(envVar => 
        !connection.credentials || 
        !connection.credentials[envVar.name] || 
        !connection.credentials[envVar.name].trim()
      ).map(envVar => envVar.name);
    }
  });
  
  // Credentials Store - Simple plain text storage (client-side only)
  Alpine.store('credentials', {
    data: null,
    
    // Initialize credentials
    init() {
      const stored = storage.get(STORAGE_KEYS.credentials);
      this.data = stored || {};
      console.log('Credentials loaded');
    },
    
    // Save credentials to localStorage
    save() {
      storage.set(STORAGE_KEYS.credentials, this.data);
      console.log('Credentials saved');
    },
    
    // Get credential for server
    get(serverId) {
      if (!this.data) this.init();
      return this.data[serverId] || null;
    },
    
    // Set credential for server
    set(serverId, credential) {
      if (!this.data) this.init();
      this.data[serverId] = credential;
      this.save();
    },
    
    // Remove credential for server
    remove(serverId) {
      if (!this.data) this.init();
      if (this.data[serverId]) {
        delete this.data[serverId];
        this.save();
        return true;
      }
      return false;
    },
    
    // Clear all credentials
    clear() {
      this.data = {};
      storage.remove(STORAGE_KEYS.credentials);
      console.log('All credentials cleared');
    }
  });
  
  // Cache Store - Section 4.1 Browser Storage Strategy
  Alpine.store('cache', {
    data: storage.get(STORAGE_KEYS.cache) || {},
    
    // Get cached data
    get(key) {
      const cached = this.data[key];
      if (!cached) return null;
      
      // Check if cache is expired (24 hours default)
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      if (Date.now() - cached.timestamp > maxAge) {
        this.remove(key);
        return null;
      }
      
      return cached.data;
    },
    
    // Set cached data
    set(key, data, maxAge = null) {
      this.data[key] = {
        data: data,
        timestamp: Date.now(),
        maxAge: maxAge
      };
      
      this.save();
      console.log('Data cached:', key);
    },
    
    // Remove cached data
    remove(key) {
      delete this.data[key];
      this.save();
      console.log('Cache removed:', key);
    },
    
    // Clear all cache
    clear() {
      this.data = {};
      this.save();
      console.log('Cache cleared');
    },
    
    // Get cache size (approximate)
    getSize() {
      try {
        return JSON.stringify(this.data).length;
      } catch {
        return 0;
      }
    },
    
    // Save to localStorage
    save() {
      debouncedSave(STORAGE_KEYS.cache, this.data);
    }
  });
  
  // Settings Store - Section 4.1 Browser Storage Strategy
  Alpine.store('settings', {
    // Default settings
    defaults: {
      defaultExportFormat: 'claude.json',
      theme: 'system', // system, light, dark
      language: 'en',
      autoSave: true,
      showNotifications: true,
      offlineMode: true
    },
    
    data: null,
    
    // Initialize settings
    init() {
      const saved = storage.get(STORAGE_KEYS.settings);
      this.data = { ...this.defaults, ...saved };
      this.save();
    },
    
    // Get setting value
    get(key) {
      if (!this.data) this.init();
      return this.data[key];
    },
    
    // Set setting value
    set(key, value) {
      if (!this.data) this.init();
      this.data[key] = value;
      this.save();
      console.log('Setting updated:', key, value);
    },
    
    // Reset to defaults
    reset() {
      this.data = { ...this.defaults };
      this.save();
      console.log('Settings reset to defaults');
    },
    
    // Get all settings
    getAll() {
      if (!this.data) this.init();
      return { ...this.data };
    },
    
    // Update multiple settings
    update(settings) {
      if (!this.data) this.init();
      Object.assign(this.data, settings);
      this.save();
      console.log('Settings updated');
    },
    
    // Save to localStorage
    save() {
      if (this.data) {
        debouncedSave(STORAGE_KEYS.settings, this.data);
      }
    },
    
    // Export settings
    export() {
      return {
        version: '1.0',
        exported: new Date().toISOString(),
        settings: this.getAll()
      };
    },
    
    // Import settings
    import(data) {
      if (!data.settings || typeof data.settings !== 'object') {
        throw new Error('Invalid settings data');
      }
      
      this.data = { ...this.defaults, ...data.settings };
      this.save();
      console.log('Settings imported');
    }
  });
  
  // Initialize stores on load
  Alpine.store('connections').init();
  Alpine.store('credentials').init();
  Alpine.store('settings').init();
});

console.log('Alpine.js stores initialized');