// Alpine.js Stores for persistent state management
// Following Section 8.3 - Alpine.js Component Architecture

// Storage keys as defined in Section 4.1
const STORAGE_KEYS = {
  bundles: 'mcp-catalogue:v1:bundles',
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
    current: null,
    
    // Create new bundle
    create(name, description = '') {
      const bundle = {
        id: Date.now().toString(),
        name: name.trim(),
        description: description.trim(),
        servers: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        metadata: {
          tags: []
        }
      };
      
      this.items.push(bundle);
      this.current = bundle;
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
      
      if (this.current && this.current.id === bundleId) {
        this.current = bundle;
      }
      
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
      
      if (this.current && this.current.id === bundleId) {
        this.current = null;
      }
      
      this.save();
      console.log('Bundle deleted:', bundle.name);
      return true;
    },
    
    // Add server to current bundle
    addServer(serverId) {
      if (!this.current) return false;
      
      if (!this.current.servers.includes(serverId)) {
        this.current.servers.push(serverId);
        this.current.updated = new Date().toISOString();
        this.save();
        console.log('Server added to bundle:', serverId);
        return true;
      }
      
      return false;
    },
    
    // Remove server from current bundle
    removeServer(serverId) {
      if (!this.current) return false;
      
      const index = this.current.servers.indexOf(serverId);
      if (index > -1) {
        this.current.servers.splice(index, 1);
        this.current.updated = new Date().toISOString();
        this.save();
        console.log('Server removed from bundle:', serverId);
        return true;
      }
      
      return false;
    },
    
    // Set current bundle
    setCurrent(bundleId) {
      const bundle = this.items.find(b => b.id === bundleId);
      this.current = bundle || null;
      return this.current;
    },
    
    // Get bundle by ID
    getById(bundleId) {
      return this.items.find(b => b.id === bundleId) || null;
    },
    
    // Check if server is in current bundle
    hasServer(serverId) {
      return this.current ? this.current.servers.includes(serverId) : false;
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
      this.current = null;
      this.save();
      console.log('Bundles imported:', data.bundles.length);
    }
  });
  
  // Credentials Store - Section 5.1 Credential Protection
  Alpine.store('credentials', {
    encrypted: true,
    data: null,
    isUnlocked: false,
    
    // Unlock credentials with passphrase
    async unlock(passphrase) {
      const encrypted = storage.get(STORAGE_KEYS.credentials);
      if (!encrypted) {
        this.data = {};
        this.isUnlocked = true;
        return this.data;
      }
      
      try {
        if (window.crypto && Alpine.store('crypto')) {
          this.data = await Alpine.store('crypto').decrypt(encrypted, passphrase);
        } else {
          // Fallback for development - store in plain text with warning
          console.warn('Crypto not available - credentials stored in plain text!');
          this.data = encrypted;
        }
        
        this.isUnlocked = true;
        console.log('Credentials unlocked');
        return this.data;
      } catch (error) {
        console.error('Failed to unlock credentials:', error);
        throw new Error('Invalid passphrase');
      }
    },
    
    // Save credentials with encryption
    async save(credentials, passphrase) {
      this.data = credentials;
      
      try {
        if (window.crypto && Alpine.store('crypto')) {
          const encrypted = await Alpine.store('crypto').encrypt(credentials, passphrase);
          storage.set(STORAGE_KEYS.credentials, encrypted);
        } else {
          // Fallback for development
          console.warn('Crypto not available - credentials stored in plain text!');
          storage.set(STORAGE_KEYS.credentials, credentials);
        }
        
        console.log('Credentials saved');
      } catch (error) {
        console.error('Failed to save credentials:', error);
        throw error;
      }
    },
    
    // Get credential for server
    get(serverId) {
      return this.isUnlocked && this.data ? this.data[serverId] : null;
    },
    
    // Set credential for server
    set(serverId, credential) {
      if (!this.isUnlocked) {
        throw new Error('Credentials are locked');
      }
      
      if (!this.data) this.data = {};
      this.data[serverId] = credential;
    },
    
    // Remove credential for server
    remove(serverId) {
      if (this.isUnlocked && this.data) {
        delete this.data[serverId];
        return true;
      }
      return false;
    },
    
    // Lock credentials
    lock() {
      this.data = null;
      this.isUnlocked = false;
      console.log('Credentials locked');
    },
    
    // Clear all credentials
    clear() {
      this.data = {};
      this.isUnlocked = false;
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
      encryptionEnabled: true,
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
  
  // Initialize settings on load
  Alpine.store('settings').init();
});

console.log('Alpine.js stores initialized');