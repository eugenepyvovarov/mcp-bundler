// Main Alpine.js app component
// Following Section 8.3 - Alpine.js Component Architecture

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    // State variables
    currentView: 'catalogue',
    servers: [],
    searchQuery: '',
    selectedCategory: 'all',
    installPrompt: null,
    isOnline: true, // Start as online, let network events update this
    isLocalFile: window.location.protocol === 'file:',
    importPreview: null,
    loading: false,
    
    // Bundle management state
    showBundleSelectorModal: false,
    showCreateBundleModal: false,
    selectedServer: null,
    selectedBundle: null,
    bundleDetailsView: false,
    showBundleDropdown: null, // Track which server's dropdown is open
    newBundleName: '',
    newBundleDescription: '',
    
    // Server details state
    showServerDetailsModal: false,
    selectedServerForDetails: null,
    
    // Connection management state
    showCreateConnectionModal: false,
    newConnectionName: '',
    newConnectionServerId: '',
    newConnectionCredentials: {},
    
    // Export management state
    showExportPreview: false,
    exportFormat: 'claude.json',
    
    // Toast notification state
    toast: {
      show: false,
      message: '',
      type: 'success' // success, error
    },
    
    // Computed properties
    get filteredServers() {
      return this.servers.filter(server => {
        const matchesSearch = server.name.toLowerCase()
          .includes(this.searchQuery.toLowerCase()) ||
          server.description.toLowerCase()
          .includes(this.searchQuery.toLowerCase()) ||
          server.tags.some(tag => tag.toLowerCase().includes(this.searchQuery.toLowerCase()));
        
        const matchesCategory = this.selectedCategory === 'all' || 
          server.category === this.selectedCategory;
        
        return matchesSearch && matchesCategory;
      });
    },
    
    get categories() {
      const cats = [...new Set(this.servers.map(s => s.category))];
      return [
        { id: 'all', name: 'All Categories' }, 
        ...cats.map(c => ({ 
          id: c, 
          name: c.charAt(0).toUpperCase() + c.slice(1) 
        }))
      ];
    },
    
    get showOfflineIndicator() {
      // Only show offline indicator for HTTP/HTTPS when actually offline
      return !this.isOnline && !this.isLocalFile && window.location.protocol.startsWith('http');
    },
    
    get sortedBundles() {
      // Return bundles sorted by latest updated date
      return [...Alpine.store('bundles').items].sort((a, b) => 
        new Date(b.updated) - new Date(a.updated)
      );
    },
    
    // Reset all modal states on initialization
    resetModalStates() {
      this.showBundleSelectorModal = false;
      this.selectedServer = null;
      this.selectedBundle = null;
      this.bundleDetailsView = false;
      this.showBundleDropdown = null;
      this.showServerDetailsModal = false;
      this.selectedServerForDetails = null;
      this.importPreview = null;
    },
    
    // Lifecycle methods
    init() {
      console.log('MCP Catalogue app initializing...');
      console.log('Protocol:', window.location.protocol);
      console.log('isLocalFile:', this.isLocalFile);
      console.log('isOnline initial:', this.isOnline);
      console.log('navigator.onLine:', navigator.onLine);
      console.log('showOfflineIndicator:', this.showOfflineIndicator);
      
      // Reset all modal states first
      this.resetModalStates();
      
      this.loadServers();
      this.setupInstallPrompt();
      this.registerServiceWorker();
      this.setupOfflineDetection();
      this.setupURLRouting();
      this.handleURLImport();
      
      // Check for shared bundle in URL
      if (window.location.hash.startsWith('#/bundle/')) {
        const encodedData = window.location.hash.replace('#/bundle/', '');
        this.importFromURL(encodedData);
      }
    },
    
    // Data loading methods
    async loadServers() {
      this.loading = true;
      
      try {
        // Try to load from network first
        const response = await fetch('./data/servers.json');
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!data || !Array.isArray(data.servers)) {
          throw new Error('Invalid server data format');
        }
        
        this.servers = data.servers;
        
        // Cache for offline use
        Alpine.store('cache').set('servers', data);
        console.log('Server catalogue loaded:', this.servers.length, 'servers');
        
      } catch (error) {
        console.warn('Failed to load servers from network:', error.message);
        
        // Load from cache if offline
        const cached = Alpine.store('cache').get('servers');
        if (cached && cached.servers && Array.isArray(cached.servers)) {
          this.servers = cached.servers;
          console.log('Server catalogue loaded from cache:', this.servers.length, 'servers');
          this.showToast('Loaded from cache - you may be offline', 'success');
        } else {
          console.error('No cached server data available');
          this.showToast('Failed to load server catalogue', 'error');
          
          // Fallback: create minimal server list
          this.servers = [
            {
              id: 'filesystem',
              name: 'Filesystem Server',
              description: 'Direct access to local file system',
              category: 'development',
              tags: ['file', 'storage', 'local'],
              official: true,
              requiredSecrets: [],
              config: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
                env: {}
              }
            },
            {
              id: 'slack',
              name: 'Slack Server',
              description: 'Interact with Slack workspaces and channels',
              category: 'productivity', 
              tags: ['slack', 'messaging', 'api'],
              official: true,
              requiredSecrets: ['SLACK_BOT_TOKEN'],
              config: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-slack'],
                env: {
                  SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}'
                }
              }
            }
          ];
          console.log('Using fallback server data');
        }
      } finally {
        this.loading = false;
      }
    },
    
    // Bundle management methods
    createNewBundle() {
      const name = prompt('Enter bundle name:');
      if (!name || !name.trim()) return;
      
      const description = prompt('Enter bundle description (optional):') || '';
      
      try {
        const bundle = Alpine.store('bundles').create(name, description);
        this.currentView = 'bundles';
        this.showToast(`Bundle "${bundle.name}" created successfully!`);
      } catch (error) {
        console.error('Failed to create bundle:', error);
        this.showToast('Failed to create bundle', 'error');
      }
    },
    
    editBundle(bundle) {
      const name = prompt('Enter new name:', bundle.name);
      if (!name || !name.trim()) return;
      
      const description = prompt('Enter new description:', bundle.description) || '';
      
      try {
        Alpine.store('bundles').update(bundle.id, { name, description });
        this.showToast(`Bundle "${name}" updated successfully!`);
      } catch (error) {
        console.error('Failed to update bundle:', error);
        this.showToast('Failed to update bundle', 'error');
      }
    },
    
    deleteBundle(bundle) {
      if (!confirm(`Are you sure you want to delete "${bundle.name}"?`)) return;
      
      try {
        Alpine.store('bundles').delete(bundle.id);
        this.showToast(`Bundle "${bundle.name}" deleted`);
      } catch (error) {
        console.error('Failed to delete bundle:', error);
        this.showToast('Failed to delete bundle', 'error');
      }
    },
    
    addToBundle(server) {
      const bundles = Alpine.store('bundles').items;
      
      // If no bundles exist, show modal to create first bundle
      if (bundles.length === 0) {
        this.showBundleSelector(server);
        return;
      }
      
      // If bundles exist, toggle dropdown for this server
      if (this.showBundleDropdown === server.id) {
        this.showBundleDropdown = null;
      } else {
        this.showBundleDropdown = server.id;
      }
    },
    
    showBundleSelector(server) {
      this.selectedServer = server;
      this.showBundleSelectorModal = true;
      this.showBundleDropdown = null; // Close any open dropdown
    },
    
    selectBundleFromDropdown(bundleId, server) {
      this.addServerToBundle(bundleId, server);
      this.showBundleDropdown = null; // Close dropdown after selection
    },
    
    createNewBundleFromDropdown(server) {
      this.showBundleSelector(server);
    },
    
    closeBundleDropdown() {
      this.showBundleDropdown = null;
    },
    
    isServerInAnyBundle(server) {
      if (!server) return false;
      const bundles = Alpine.store('bundles').items;
      return bundles.some(bundle => bundle.servers.includes(server.id));
    },

    addServerToBundle(bundleId, server) {
      try {
        const bundle = Alpine.store('bundles').items.find(b => b.id === bundleId);
        if (!bundle) {
          this.showToast('Bundle not found', 'error');
          return;
        }
        
        // Check if server already in bundle
        if (bundle.servers.includes(server.id)) {
          this.showToast(`${server.name} is already in ${bundle.name}`);
          return;
        }
        
        // Add server to bundle
        bundle.servers.push(server.id);
        bundle.updated = new Date().toISOString();
        Alpine.store('bundles').save();
        
        this.showToast(`${server.name} added to ${bundle.name}`);
        this.showBundleSelectorModal = false;
      } catch (error) {
        console.error('Failed to add server to bundle:', error);
        this.showToast('Failed to add server to bundle', 'error');
      }
    },
    
    createBundleAndAddServer(server) {
      // Close the bundle selector modal and show create bundle modal
      this.showBundleSelectorModal = false;
      this.showCreateBundleModal = true;
      this.selectedServer = server;
      this.newBundleName = '';
      this.newBundleDescription = '';
    },

    openCreateBundleModal() {
      this.showCreateBundleModal = true;
      this.selectedServer = null; // No server to add when creating from bundles page
      this.newBundleName = '';
      this.newBundleDescription = '';
    },

    createBundleWithModal(server) {
      if (!this.newBundleName?.trim()) return;
      
      try {
        const bundle = Alpine.store('bundles').create(this.newBundleName.trim(), this.newBundleDescription.trim());
        
        // Add the server to the new bundle
        if (server) {
          bundle.servers.push(server.id);
          bundle.updated = new Date().toISOString();
          Alpine.store('bundles').save();
        }
        
        // Close modal and show success
        this.showCreateBundleModal = false;
        this.showToast(`Bundle "${bundle.name}" created successfully!`);
        
        // Clear form
        this.newBundleName = '';
        this.newBundleDescription = '';
        this.selectedServer = null;
        
      } catch (error) {
        console.error('Failed to create bundle:', error);
        this.showToast('Failed to create bundle', 'error');
      }
    },
    
    // Connection management methods
    clearConnectionForm() {
      this.newConnectionName = '';
      this.newConnectionServerId = '';
      this.newConnectionCredentials = {};
    },
    
    createConnection() {
      if (!this.newConnectionName?.trim() || !this.newConnectionServerId) {
        this.showToast('Please fill in all required fields', 'error');
        return;
      }
      
      try {
        const connection = Alpine.store('connections').create(
          this.newConnectionName.trim(),
          this.newConnectionServerId,
          this.newConnectionCredentials
        );
        
        this.showCreateConnectionModal = false;
        this.clearConnectionForm();
        this.showToast(`Connection "${connection.name}" created successfully!`);
        
      } catch (error) {
        console.error('Failed to create connection:', error);
        this.showToast('Failed to create connection', 'error');
      }
    },
    
    editConnection(connection) {
      // For now, just show a simple prompt to edit credentials
      // TODO: Create a proper edit modal
      const server = this.servers.find(s => s.id === connection.serverId);
      if (!server || !server.requiredSecrets) {
        this.showToast('No credentials to configure', 'error');
        return;
      }
      
      const newCredentials = { ...connection.credentials };
      let hasChanges = false;
      
      for (const secret of server.requiredSecrets) {
        const currentValue = newCredentials[secret] || '';
        const newValue = prompt(`Enter ${secret} for ${connection.name}:`, currentValue);
        
        if (newValue !== null && newValue !== currentValue) {
          newCredentials[secret] = newValue;
          hasChanges = true;
        }
      }
      
      if (hasChanges) {
        try {
          Alpine.store('connections').updateCredentials(connection.id, newCredentials);
          this.showToast(`Credentials updated for ${connection.name}`);
        } catch (error) {
          console.error('Failed to update credentials:', error);
          this.showToast('Failed to update credentials', 'error');
        }
      }
    },
    
    deleteConnection(connection) {
      if (!confirm(`Are you sure you want to delete "${connection.name}"?`)) return;
      
      try {
        Alpine.store('connections').delete(connection.id);
        this.showToast(`Connection "${connection.name}" deleted`);
      } catch (error) {
        console.error('Failed to delete connection:', error);
        this.showToast(error.message, 'error');
      }
    },
    
    // Server-to-Bundle workflow methods  
    showBundleSelector(server) {
      this.selectedServer = server;
      this.showBundleSelectorModal = true;
    },
    
    addServerToBundle(bundleId, server) {
      try {
        Alpine.store('bundles').addServer(bundleId, server.id);
        this.showBundleSelectorModal = false;
        this.selectedServer = null;
        this.showToast(`${server.name} added to bundle`);
      } catch (error) {
        console.error('Failed to add server to bundle:', error);
        this.showToast('Failed to add server to bundle', 'error');
      }
    },
    
    createBundleAndAddServer(server) {
      this.showBundleSelectorModal = false;
      this.showCreateBundleModal = true;
      this.selectedServer = server;
      this.newBundleName = '';
      this.newBundleDescription = '';
    },
    
    // Update createBundleWithModal to handle servers
    createBundleWithModal() {
      if (!this.newBundleName?.trim()) return;
      
      try {
        const bundle = Alpine.store('bundles').create(this.newBundleName.trim(), this.newBundleDescription.trim());
        
        // Add the server to the new bundle if selected
        if (this.selectedServer) {
          Alpine.store('bundles').addServer(bundle.id, this.selectedServer.id);
        }
        
        // Close modal and show success
        this.showCreateBundleModal = false;
        this.showToast(`Bundle "${bundle.name}" created successfully!`);
        
        // Clear form
        this.newBundleName = '';
        this.newBundleDescription = '';
        this.selectedServer = null;
        
      } catch (error) {
        console.error('Failed to create bundle:', error);
        this.showToast('Failed to create bundle', 'error');
      }
    },
    
    // Bundle details functionality
    viewBundleDetails(bundle) {
      this.selectedBundle = bundle;
      this.currentView = 'bundle-details';
      this.bundleDetailsView = false; // Using page view instead of modal
    },
    
    viewBundleDetailsWithURL(bundle) {
      this.navigateToBundle(bundle);
    },
    
    closeBundleDetails() {
      this.selectedBundle = null;
      this.bundleDetailsView = false;
      // Return to bundles list
      window.location.hash = '#/bundles';
    },
    
    // Server details functionality
    viewServerDetails(server) {
      this.selectedServerForDetails = server;
      this.showServerDetailsModal = true;
    },
    
    viewServerDetailsWithURL(server) {
      this.navigateToServer(server);
    },
    
    closeServerDetails() {
      this.selectedServerForDetails = null;
      this.showServerDetailsModal = false;
      // Return to catalogue
      window.location.hash = '#/';
    },
    
    removeServerFromBundle(serverId, bundleId) {
      try {
        const bundle = Alpine.store('bundles').items.find(b => b.id === bundleId);
        if (!bundle) return;
        
        bundle.servers = bundle.servers.filter(id => id !== serverId);
        bundle.updated = new Date().toISOString();
        Alpine.store('bundles').save();
        
        const server = this.servers.find(s => s.id === serverId);
        this.showToast(`${server?.name || 'Server'} removed from ${bundle.name}`);
        
        // Update selectedBundle if we're viewing details
        if (this.selectedBundle && this.selectedBundle.id === bundleId) {
          this.selectedBundle = bundle;
        }
      } catch (error) {
        console.error('Failed to remove server from bundle:', error);
        this.showToast('Failed to remove server', 'error');
      }
    },
    
    getBundleServers(bundle) {
      return (bundle.servers || []).map(serverId => 
        this.servers.find(s => s.id === serverId)
      ).filter(Boolean);
    },
    
    // Connection attachment methods for bundle details
    attachConnectionToServer(bundleId, serverId, connectionId) {
      try {
        Alpine.store('bundles').attachConnection(bundleId, serverId, connectionId);
        this.showToast('Connection attached successfully');
      } catch (error) {
        console.error('Failed to attach connection:', error);
        this.showToast('Failed to attach connection', 'error');
      }
    },
    
    detachConnectionFromServer(bundleId, serverId) {
      try {
        Alpine.store('bundles').detachConnection(bundleId, serverId);
        this.showToast('Connection detached');
      } catch (error) {
        console.error('Failed to detach connection:', error);
        this.showToast('Failed to detach connection', 'error');
      }
    },
    
    getServerConnection(bundleId, serverId) {
      return Alpine.store('bundles').getServerConnection(bundleId, serverId);
    },
    
    getServerConnections(serverId) {
      if (!serverId) return [];
      return Alpine.store('connections').getByServerId(serverId);
    },
    
    removeFromBundle(serverId) {
      try {
        const success = Alpine.store('bundles').removeServer(serverId);
        if (success) {
          const server = this.servers.find(s => s.id === serverId);
          this.showToast(`${server?.name || serverId} removed from bundle`);
        }
      } catch (error) {
        console.error('Failed to remove server from bundle:', error);
        this.showToast('Failed to remove server from bundle', 'error');
      }
    },
    
    
    // Sharing methods
    shareBundle(bundle) {
      const shareData = {
        name: bundle.name,
        description: bundle.description,
        servers: bundle.servers,
        metadata: {
          ...bundle.metadata,
          shared: new Date().toISOString()
        }
      };
      
      try {
        const encoded = btoa(JSON.stringify(shareData));
        const url = `${window.location.origin}${window.location.pathname}#/bundle/${encoded}`;
        
        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => {
            this.showToast('Bundle URL copied to clipboard!');
          }).catch(() => {
            this.showToast('Failed to copy URL', 'error');
          });
        } else {
          // Fallback for older browsers
          this.showToast('Share URL: ' + url);
        }
        
        // Use native share API if available (mobile)
        if (navigator.share) {
          navigator.share({
            title: `MCP Bundle: ${bundle.name}`,
            text: bundle.description,
            url: url
          }).catch(error => {
            console.log('Native share cancelled or failed:', error);
          });
        }
        
      } catch (error) {
        console.error('Failed to share bundle:', error);
        this.showToast('Failed to create share URL', 'error');
      }
    },
    
    async importFromURL(encodedData) {
      try {
        const decoded = atob(encodedData);
        const sharedBundle = JSON.parse(decoded);
        
        // Validate bundle structure
        if (!sharedBundle.name || !Array.isArray(sharedBundle.servers)) {
          throw new Error('Invalid bundle format');
        }
        
        // Validate that servers exist in our catalogue
        const validServers = sharedBundle.servers.filter(serverId => 
          this.servers.find(s => s.id === serverId)
        );
        
        if (validServers.length === 0) {
          throw new Error('No valid servers found in shared bundle');
        }
        
        // Show preview before importing
        this.importPreview = {
          ...sharedBundle,
          servers: validServers,
          invalidServers: sharedBundle.servers.filter(s => !validServers.includes(s))
        };
        this.currentView = 'import-preview';
        
        // Clear URL
        window.history.replaceState({}, '', window.location.pathname);
        
      } catch (error) {
        console.error('Failed to import from URL:', error);
        this.showToast('Invalid bundle URL', 'error');
        window.history.replaceState({}, '', window.location.pathname);
      }
    },
    
    confirmImport() {
      if (!this.importPreview) return;
      
      try {
        // Create new bundle from shared data
        const bundle = Alpine.store('bundles').create(
          this.importPreview.name,
          this.importPreview.description
        );
        
        // Add valid servers
        this.importPreview.servers.forEach(serverId => {
          Alpine.store('bundles').addServer(serverId);
        });
        
        this.showToast(`Bundle "${bundle.name}" imported successfully!`);
        this.currentView = 'bundles';
        this.importPreview = null;
        
      } catch (error) {
        console.error('Failed to import bundle:', error);
        this.showToast('Failed to import bundle', 'error');
      }
    },
    
    // Export methods
    exportBundle(bundle) {
      try {
        const format = Alpine.store('settings').get('defaultExportFormat') || 'claude.json';
        
        if (format === 'claude.json') {
          this.exportClaudeFormat(bundle);
        } else {
          this.exportCustomFormat(bundle);
        }
        
      } catch (error) {
        console.error('Failed to export bundle:', error);
        this.showToast('Failed to export bundle', 'error');
      }
    },
    
    exportBundleWithFormat(bundle, format) {
      try {
        if (format === 'claude.json') {
          this.exportClaudeFormat(bundle);
        } else {
          this.exportCustomFormat(bundle);
        }
        
        this.showExportPreview = false;
        
      } catch (error) {
        console.error('Failed to export bundle:', error);
        this.showToast('Failed to export bundle', 'error');
      }
    },
    
    exportClaudeFormat(bundle) {
      const mcpServers = {};
      let hasRealCredentials = false;
      
      bundle.servers.forEach(serverId => {
        const server = this.servers.find(s => s.id === serverId);
        if (server && server.config) {
          // Start with base config
          const serverConfig = {
            command: server.config.command,
            args: server.config.args,
            env: { ...server.config.env || {} }
          };
          
          // Check if this server has an attached connection
          const attachedConnection = Alpine.store('bundles').getServerConnection(bundle.id, serverId);
          
          if (attachedConnection && attachedConnection.credentials) {
            // Use credentials from attached connection
            Object.keys(attachedConnection.credentials).forEach(key => {
              if (attachedConnection.credentials[key] && attachedConnection.credentials[key].trim()) {
                serverConfig.env[key] = attachedConnection.credentials[key];
                hasRealCredentials = true;
              }
            });
          } else {
            // No attached connection - use placeholder format for required secrets
            if (server.requiredSecrets && server.requiredSecrets.length > 0) {
              server.requiredSecrets.forEach(secret => {
                if (!serverConfig.env[secret]) {
                  serverConfig.env[secret] = `\${${secret}}`;
                }
              });
            }
          }
          
          mcpServers[serverId] = serverConfig;
        }
      });
      
      const claudeConfig = { mcpServers };
      this.downloadFile(
        JSON.stringify(claudeConfig, null, 2),
        `${bundle.name.replace(/[^a-zA-Z0-9]/g, '_')}.claude.json`,
        'application/json'
      );
      
      this.showToast(
        hasRealCredentials ? 
        'Claude configuration exported with your credentials' : 
        'Claude configuration exported with placeholder variables'
      );
    },
    
    exportCustomFormat(bundle) {
      let hasRealCredentials = false;
      
      const servers = bundle.servers.map(serverId => {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) return null;
        
        // Start with base config
        const exportConfig = { ...server.config };
        
        // Check if this server has an attached connection
        const attachedConnection = Alpine.store('bundles').getServerConnection(bundle.id, serverId);
        
        if (attachedConnection && attachedConnection.credentials && exportConfig.env) {
          // Use credentials from attached connection
          Object.keys(attachedConnection.credentials).forEach(key => {
            if (attachedConnection.credentials[key] && attachedConnection.credentials[key].trim()) {
              exportConfig.env[key] = attachedConnection.credentials[key];
              hasRealCredentials = true;
            }
          });
        } else {
          // No attached connection - use placeholder format for required secrets
          if (server.requiredSecrets && server.requiredSecrets.length > 0 && exportConfig.env) {
            server.requiredSecrets.forEach(secret => {
              if (!exportConfig.env[secret]) {
                exportConfig.env[secret] = `\${${secret}}`;
              }
            });
          }
        }
        
        // Determine credentials info for export metadata
        const credentialsInfo = attachedConnection && attachedConnection.credentials ? 
          Object.keys(attachedConnection.credentials).map(key => ({
            name: key,
            required: server.requiredSecrets?.includes(key) || false,
            hasValue: !!(attachedConnection.credentials[key] && attachedConnection.credentials[key].trim())
          })) : 
          (server.requiredSecrets || []).map(secret => ({
            name: secret,
            required: true,
            hasValue: false
          }));
        
        return {
          id: serverId,
          name: server.name,
          config: exportConfig,
          credentials: credentialsInfo,
          connectionId: attachedConnection ? attachedConnection.id : null,
          connectionName: attachedConnection ? attachedConnection.name : null
        };
      }).filter(Boolean);
      
      const customBundle = {
        schema: 'https://schemas.mcp-catalogue.dev/bundle@v1',
        bundle: {
          id: bundle.id,
          name: bundle.name,
          description: bundle.description,
          version: '1.0.0',
          servers: servers,
          exported: new Date().toISOString(),
          hasCredentials: hasRealCredentials
        }
      };
      
      this.downloadFile(
        JSON.stringify(customBundle, null, 2),
        `${bundle.name.replace(/[^a-zA-Z0-9]/g, '_')}.mcpbundle.json`,
        'application/json'
      );
      
      this.showToast(
        hasRealCredentials ? 
        'Custom bundle exported with your credentials' : 
        'Custom bundle exported with placeholder variables'
      );
    },
    
    downloadFile(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      URL.revokeObjectURL(url);
    },
    
    // Credential management methods
    async unlockCredentials() {
      const passphrase = prompt('Enter your credentials passphrase:');
      if (!passphrase) return;
      
      try {
        await Alpine.store('credentials').unlock(passphrase);
        this.showToast('Credentials unlocked successfully');
      } catch (error) {
        console.error('Failed to unlock credentials:', error);
        this.showToast('Invalid passphrase', 'error');
      }
    },
    
    lockCredentials() {
      Alpine.store('credentials').lock();
      this.showToast('Credentials locked');
    },
    
    async setCredential(serverId, secretName) {
      if (!Alpine.store('credentials').isUnlocked) {
        this.showToast('Please unlock credentials first', 'error');
        return;
      }
      
      const value = prompt(`Enter ${secretName} for ${serverId}:`);
      if (!value) return;
      
      try {
        Alpine.store('credentials').set(serverId, {
          ...Alpine.store('credentials').get(serverId),
          [secretName]: value
        });
        
        // Save encrypted credentials
        const passphrase = prompt('Enter passphrase to save:');
        if (passphrase) {
          await Alpine.store('credentials').save(
            Alpine.store('credentials').data,
            passphrase
          );
          this.showToast('Credential saved securely');
        }
      } catch (error) {
        console.error('Failed to save credential:', error);
        this.showToast('Failed to save credential', 'error');
      }
    },
    
    removeCredential(serverId, secretName) {
      if (!Alpine.store('credentials').isUnlocked) {
        this.showToast('Please unlock credentials first', 'error');
        return;
      }
      
      if (!confirm(`Remove ${secretName} for ${serverId}?`)) return;
      
      try {
        const serverCreds = Alpine.store('credentials').get(serverId) || {};
        delete serverCreds[secretName];
        Alpine.store('credentials').set(serverId, serverCreds);
        this.showToast('Credential removed');
      } catch (error) {
        console.error('Failed to remove credential:', error);
        this.showToast('Failed to remove credential', 'error');
      }
    },
    
    getCredentialStatus(serverId) {
      if (!Alpine.store('credentials').isUnlocked) return 'locked';
      
      const server = this.servers.find(s => s.id === serverId);
      if (!server || !server.requiredSecrets || server.requiredSecrets.length === 0) {
        return 'none-required';
      }
      
      const serverCreds = Alpine.store('credentials').get(serverId) || {};
      const hasAllRequired = server.requiredSecrets.every(secret => 
        serverCreds[secret] && serverCreds[secret].trim()
      );
      
      return hasAllRequired ? 'complete' : 'incomplete';
    },
    
    // Settings methods
    clearAllData() {
      if (!confirm('Are you sure you want to clear all data? This cannot be undone.')) {
        return;
      }
      
      try {
        Alpine.store('bundles').items = [];
        Alpine.store('bundles').save();
        
        Alpine.store('credentials').clear();
        Alpine.store('cache').clear();
        Alpine.store('settings').reset();
        
        this.showToast('All data cleared');
        this.currentView = 'catalogue';
        
      } catch (error) {
        console.error('Failed to clear data:', error);
        this.showToast('Failed to clear all data', 'error');
      }
    },
    
    // PWA methods
    setupInstallPrompt() {
      window.addEventListener('beforeinstallprompt', (e) => {
        console.log('PWA install prompt available');
        e.preventDefault();
        this.installPrompt = e;
      });
      
      window.addEventListener('appinstalled', () => {
        console.log('PWA installed');
        this.installPrompt = null;
        this.showToast('App installed successfully!');
      });
    },
    
    async installApp() {
      if (!this.installPrompt) {
        this.showToast('App installation not available', 'error');
        return;
      }
      
      try {
        this.installPrompt.prompt();
        const { outcome } = await this.installPrompt.userChoice;
        
        if (outcome === 'accepted') {
          console.log('User accepted PWA install');
        } else {
          console.log('User dismissed PWA install');
        }
        
        this.installPrompt = null;
        
      } catch (error) {
        console.error('PWA install failed:', error);
        this.showToast('Installation failed', 'error');
      }
    },
    
    // Service Worker methods
    registerServiceWorker() {
      // Only register service worker in production (when served over HTTPS or localhost)
      const isProduction = window.location.protocol === 'https:' || 
                           window.location.hostname === 'localhost' ||
                           window.location.hostname === '127.0.0.1';
      
      if (!isProduction) {
        console.log('Service Worker registration skipped in development');
        return;
      }
      
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
          .then(registration => {
            console.log('Service Worker registered:', registration);
            
            // Listen for service worker messages
            navigator.serviceWorker.addEventListener('message', event => {
              if (event.data && event.data.type === 'IMPORT_BUNDLE') {
                this.importFromURL(event.data.bundleData);
              }
            });
            
            // Handle service worker updates
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing;
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  this.showToast('App update available. Refresh to update.', 'success');
                }
              });
            });
            
          })
          .catch(error => {
            console.error('Service Worker registration failed:', error);
          });
      }
    },
    
    // Network detection
    setupOfflineDetection() {
      // For local files, always stay online
      if (this.isLocalFile) {
        this.isOnline = true;
        console.log('Local file detected - staying online');
        return;
      }
      
      // For HTTP/HTTPS, check actual network status
      this.isOnline = navigator.onLine;
      console.log('Initial network status:', this.isOnline);
      
      window.addEventListener('online', () => {
        console.log('Network came back online');
        this.isOnline = true;
        this.showToast('Back online');
        this.loadServers(); // Refresh data when back online
      });
      
      window.addEventListener('offline', () => {
        console.log('Network went offline');
        this.isOnline = false;
        this.showToast('You are offline', 'error');
      });
    },
    
    // URL routing
    setupURLRouting() {
      // Handle initial route
      this.handleRouteChange();
      
      // Listen for hash changes
      window.addEventListener('hashchange', () => {
        this.handleRouteChange();
      });
      
      // Listen for popstate events (back/forward navigation)
      window.addEventListener('popstate', () => {
        this.handleRouteChange();
      });
    },
    
    handleRouteChange() {
      const hash = window.location.hash;
      
      // First reset all modal states
      this.showBundleSelectorModal = false;
      this.bundleDetailsView = false;
      this.showServerDetailsModal = false;
      this.showBundleDropdown = null;
      this.selectedServer = null;
      this.selectedBundle = null;
      this.selectedServerForDetails = null;
      
      if (hash.startsWith('#/bundle/')) {
        // Shared bundle import
        const encodedData = hash.replace('#/bundle/', '');
        this.importFromURL(encodedData);
      } else if (hash.startsWith('#/server/')) {
        // Individual server view
        const serverId = hash.replace('#/server/', '');
        this.viewServerFromURL(serverId);
      } else if (hash.startsWith('#/my-bundle/')) {
        // Individual bundle view
        const bundleId = hash.replace('#/my-bundle/', '');
        this.viewBundleFromURL(bundleId);
      } else if (hash === '#/bundles') {
        // Bundles list view
        this.currentView = 'bundles';
      } else if (hash === '#/settings') {
        // Settings view
        this.currentView = 'settings';
      } else if (hash === '#/' || hash === '') {
        // Home/catalogue view
        this.currentView = 'catalogue';
      }
    },
    
    // Navigation with URL updates
    navigateToView(view) {
      this.currentView = view;
      if (view === 'catalogue') {
        window.location.hash = '#/';
      } else {
        window.location.hash = `#/${view}`;
      }
    },
    
    navigateToServer(server) {
      this.viewServerDetails(server);
      window.location.hash = `#/server/${server.id}`;
    },
    
    navigateToBundle(bundle) {
      this.viewBundleDetails(bundle);
      window.location.hash = `#/my-bundle/${bundle.id}`;
    },
    
    viewServerFromURL(serverId) {
      const server = this.servers.find(s => s.id === serverId);
      if (server) {
        this.currentView = 'catalogue';
        this.viewServerDetails(server);
      }
    },
    
    viewBundleFromURL(bundleId) {
      const bundle = Alpine.store('bundles').items.find(b => b.id === bundleId);
      if (bundle) {
        this.currentView = 'bundle-details';
        this.selectedBundle = bundle;
        this.bundleDetailsView = false; // We're using page view now, not modal
      } else {
        // Bundle not found, redirect to bundles list
        console.warn('Bundle not found:', bundleId);
        this.showToast('Bundle not found', 'error');
        this.navigateToView('bundles');
      }
    },

    // URL handling
    handleURLImport() {
      // This is now handled in setupURLRouting
    },
    
    // Utility methods
    showToast(message, type = 'success') {
      this.toast = {
        show: true,
        message: message,
        type: type
      };
      
      // Auto-hide after 3 seconds
      setTimeout(() => {
        this.toast.show = false;
      }, 3000);
    },
    
    formatDate(dateString) {
      try {
        return new Date(dateString).toLocaleDateString();
      } catch {
        return 'Invalid date';
      }
    },
    
    // Development helpers
    async testCrypto() {
      try {
        const result = await Alpine.store('crypto').test();
        console.log('Crypto test result:', result);
        this.showToast(
          result.success ? 'Crypto test passed' : 'Crypto test failed',
          result.success ? 'success' : 'error'
        );
      } catch (error) {
        console.error('Crypto test error:', error);
        this.showToast('Crypto test failed', 'error');
      }
    }
  }));
});

console.log('Alpine.js app component initialized');