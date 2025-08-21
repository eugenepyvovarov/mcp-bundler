// Main Alpine.js app component
// Following Section 8.3 - Alpine.js Component Architecture

// Import server utilities and database
import * as serverUtils from './serverUtils.js';
import database from './database.js';

// Make utilities available globally for debugging
window.serverUtils = serverUtils;
window.database = database;

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    // State variables
    currentView: 'catalogue',
    servers: [],
    serverCategories: [], // Categories fetched from database
    searchQuery: '',
    selectedCategory: 'All Servers',
    installPrompt: null,
    isOnline: true, // Start as online, let network events update this
    isLocalFile: window.location.protocol === 'file:',
    importPreview: null,
    loading: false,
    selectedPackageIndex: {}, // Track selected package for each server
    
    // Pagination state
    currentPage: 1,
    serversPerPage: 50,
    
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
    showEditConnectionModal: false,
    newConnectionName: '',
    newConnectionServerId: '',
    newConnectionPackageId: '',
    newConnectionCredentials: {},
    editingConnection: null,
    editConnectionName: '',
    editConnectionCredentials: {},
    showCredentials: {}, // Track which credentials are shown for create modal
    showEditCredentials: {}, // Track which credentials are shown for edit modal
    
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
      // Return paginated servers
      const startIndex = (this.currentPage - 1) * this.serversPerPage;
      const endIndex = startIndex + this.serversPerPage;
      return this.servers.slice(startIndex, endIndex);
    },
    
    get totalPages() {
      return Math.ceil(this.servers.length / this.serversPerPage);
    },
    
    get paginationInfo() {
      const startIndex = (this.currentPage - 1) * this.serversPerPage + 1;
      const endIndex = Math.min(startIndex + this.serversPerPage - 1, this.servers.length);
      return {
        start: startIndex,
        end: endIndex,
        total: this.servers.length
      };
    },
    
    // Debounced search
    searchDebounceTimeout: null,
    
    async performSearch() {
      // Clear existing timeout
      if (this.searchDebounceTimeout) {
        clearTimeout(this.searchDebounceTimeout);
      }
      
      // Debounce search by 300ms
      this.searchDebounceTimeout = setTimeout(async () => {
        this.loading = true;
        this.currentPage = 1; // Reset to first page when searching
        try {
          if (this.searchQuery && this.searchQuery.trim() !== '') {
            // Use database full-text search
            const results = await database.searchServers(this.searchQuery, 10000);
            this.servers = await this.transformServersFromDB(results);
          } else {
            // Load all servers if no search query
            const allServers = await database.getServers(10000);
            this.servers = await this.transformServersFromDB(allServers);
          }
          
          // Update selected package indices
          this.servers.forEach(server => {
            if (server.packages && !this.selectedPackageIndex[server.id]) {
              this.selectedPackageIndex[server.id] = serverUtils.selectDefaultPackage(server.packages);
            }
          });
        } catch (error) {
          console.error('Search failed:', error);
          this.showToast('Search failed', 'error');
        } finally {
          this.loading = false;
        }
      }, 300);
    },
    
    get categories() {
      return this.serverCategories || [];
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
    async init() {
      console.log('MCP Catalogue app initializing...');
      console.log('Protocol:', window.location.protocol);
      console.log('isLocalFile:', this.isLocalFile);
      console.log('isOnline initial:', this.isOnline);
      console.log('navigator.onLine:', navigator.onLine);
      console.log('showOfflineIndicator:', this.showOfflineIndicator);
      
      // Reset all modal states first
      this.resetModalStates();
      
      await this.loadServers();
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
        // Initialize database and load servers
        await database.init();
        
        // Load categories from database
        const categories = await database.getCategories();
        // Filter out categories with 0 servers
        const nonEmptyCategories = categories.filter(cat => cat.server_count > 0);
        this.serverCategories = [
          { name: 'All Servers', server_count: null },
          ...nonEmptyCategories
        ];
        
        // Load all servers from database
        const dbServers = await database.getServers(10000);
        
        // Transform database results to match expected format
        this.servers = await this.transformServersFromDB(dbServers);
        
        // Initialize selected package index for each server
        this.servers.forEach(server => {
          if (server.packages) {
            this.selectedPackageIndex[server.id] = serverUtils.selectDefaultPackage(server.packages);
          }
        });
        
        console.log('Server catalogue loaded from database:', this.servers.length, 'servers');
        
        // Get and display database stats
        const stats = await database.getStats();
        console.log('Database stats:', stats);
        
      } catch (error) {
        console.error('Failed to load servers from database:', error);
        this.servers = [];
        this.showToast('Failed to load server catalogue', 'error');
      } finally {
        this.loading = false;
      }
    },
    
    // Transform database results to match the expected format
    async transformServersFromDB(servers, loadFullDetails = false) {
      const transformed = [];
      
      for (const server of servers) {
        let fullServer = server;
        
        // Load full details if explicitly requested OR if server might have environment variables
        if (loadFullDetails && !server.packages) {
          fullServer = await database.getServerById(server.id);
        } else if (server.packages?.length === 0 || (server.packages?.length > 0 && server.packages.some(pkg => 
            pkg.environment_variables?.length > 0 && 
            !pkg.environment_variables[0].name
          ))) {
          // Load full details for servers with:
          // 1. No packages (might have environment variables we haven't loaded)
          // 2. Placeholder packages without actual env var names
          fullServer = await database.getServerById(server.id);
        }
        
        if (fullServer) {
          // Transform to match expected structure
          const transformedServer = {
            id: fullServer.id,
            name: fullServer.name,
            display_name: fullServer.display_name || fullServer.name,
            description: fullServer.description,
            ai_description: fullServer.ai_description,
            repository: fullServer.repository_url ? {
              url: fullServer.repository_url,
              source: fullServer.repository_source || 'github',
              id: fullServer.repository_id
            } : null,
            // Flatten repository URL for direct access
            repository_url: fullServer.repository_url,
            repository_path: fullServer.repository_url ? 
              fullServer.repository_url.replace('https://github.com/', '') : null,
            version_detail: {
              version: fullServer.version,
              release_date: fullServer.release_date,
              is_latest: fullServer.is_latest
            },
            packages: fullServer.packages || [],
            // Keep nested github object for compatibility
            github: fullServer.stars !== undefined ? {
              stars: fullServer.stars,
              forks: fullServer.forks,
              watchers: fullServer.watchers,
              open_issues: fullServer.open_issues,
              language: fullServer.language,
              license: fullServer.license,
              homepage: fullServer.homepage,
              archived: fullServer.archived,
              updatedAt: fullServer.github_updated_at,
              createdAt: fullServer.github_created_at,
              topics: fullServer.github_topics ? 
                (typeof fullServer.github_topics === 'string' ? 
                  fullServer.github_topics.split(',').map(t => t.trim()).filter(t => t) : 
                  (Array.isArray(fullServer.github_topics) ? fullServer.github_topics : [])) : []
            } : null,
            // Also flatten GitHub data for easier access in templates
            stars: fullServer.stars,
            forks: fullServer.forks,
            watchers: fullServer.watchers,
            open_issues: fullServer.open_issues,
            language: fullServer.language,
            license: fullServer.license,
            homepage: fullServer.homepage,
            archived: fullServer.archived,
            github_updated_at: fullServer.github_updated_at,
            github_created_at: fullServer.github_created_at,
            github_topics: fullServer.github_topics ? 
              (typeof fullServer.github_topics === 'string' ? 
                fullServer.github_topics.split(',').map(t => t.trim()).filter(t => t) : 
                (Array.isArray(fullServer.github_topics) ? fullServer.github_topics : [])) : [],
            categories: fullServer.categories ? 
              (typeof fullServer.categories === 'string' ? 
                fullServer.categories.split(',').map(c => c.trim()).filter(c => c) : 
                (Array.isArray(fullServer.categories) ? fullServer.categories : [])) : [],
            keywords: fullServer.keywords ? 
              (typeof fullServer.keywords === 'string' ? 
                fullServer.keywords.split(',').map(k => k.trim()).filter(k => k) : 
                (Array.isArray(fullServer.keywords) ? fullServer.keywords : [])) : []
          };
          
          // Transform packages to match expected structure
          if (transformedServer.packages && Array.isArray(transformedServer.packages)) {
            transformedServer.packages = transformedServer.packages.map(pkg => ({
              registry_name: pkg.registry_name,
              name: pkg.package_name || pkg.name,
              version: pkg.version,
              runtime_hint: pkg.runtime_hint,
              environment_variables: pkg.environment_variables || [],
              package_arguments: pkg.package_arguments || []
            }));
          }
          
          transformed.push(transformedServer);
        }
      }
      
      return transformed;
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
      return bundles.some(bundle => 
        bundle.servers && bundle.servers.some(s => s.serverId === server.id)
      );
    },

    addServerToBundle(bundleId, server) {
      try {
        const bundle = Alpine.store('bundles').items.find(b => b.id === bundleId);
        if (!bundle) {
          this.showToast('Bundle not found', 'error');
          return;
        }
        
        // Initialize servers array if needed
        if (!bundle.servers) {
          bundle.servers = [];
        }
        
        // Check if server already in bundle
        if (bundle.servers.some(s => s.serverId === server.id)) {
          this.showToast(`${server.name} is already in ${bundle.name}`);
          return;
        }
        
        // Get selected package index or default
        const packageIndex = this.selectedPackageIndex[server.id] || 0;
        
        // Add server to bundle with package index
        bundle.servers.push({
          serverId: server.id,
          packageIndex: packageIndex,
          connectionId: null
        });
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
      this.newConnectionPackageId = '';
      this.newConnectionCredentials = {};
    },
    
    // Initialize credentials object for selected server (legacy method)
    initializeCredentials(serverId) {
      const server = this.servers.find(s => s.id === serverId);
      if (server && this.serverNeedsCredentials(server)) {
        const secrets = this.getPackageSecrets(server, 0);
        const credentials = {};
        secrets.forEach(secret => {
          credentials[secret] = '';
        });
        this.newConnectionCredentials = credentials;
      } else {
        this.newConnectionCredentials = {};
      }
    },
    
    // Initialize credentials for specific package from database
    async initializeCredentialsForPackage(serverId, packageKey) {
      if (!packageKey || packageKey === '') {
        this.newConnectionCredentials = {};
        return;
      }
      
      try {
        // Parse the composite key: serverId::registryName::packageName
        const [keyServerId, registryName, packageName] = packageKey.split('::');
        
        // Get the full server details from database to get packages with environment variables
        const serverDetails = await database.getServerById(serverId);
        if (!serverDetails || !serverDetails.packages) {
          this.newConnectionCredentials = {};
          return;
        }
        
        const pkg = serverDetails.packages.find(p => 
          p.registry_name === registryName && p.package_name === packageName
        );
        
        if (!pkg) {
          this.newConnectionCredentials = {};
          return;
        }
        
        // Use environment variables from the package data loaded from database
        if (pkg.environment_variables && pkg.environment_variables.length > 0) {
          const credentials = {};
          pkg.environment_variables.forEach(envVar => {
            credentials[envVar.name] = '';
          });
          this.newConnectionCredentials = credentials;
        } else {
          this.newConnectionCredentials = {};
        }
        
      } catch (error) {
        console.error('Failed to get package environment variables:', error);
        this.newConnectionCredentials = {};
      }
    },
    
    // Load packages for a server when selected in connection modal
    async loadServerPackages(serverId) {
      if (!serverId) {
        return;
      }
      
      try {
        // Find the server in our list
        const serverIndex = this.servers.findIndex(s => s.id === serverId);
        if (serverIndex === -1) {
          return;
        }
        
        // Get full server details with packages from database
        const serverDetails = await database.getServerById(serverId);
        if (serverDetails && serverDetails.packages) {
          // Update the server in our list with the full package details
          this.servers[serverIndex].packages = serverDetails.packages;
          
          // Auto-select package if there's only one with environment variables
          const packagesWithEnvVars = this.getPackagesWithEnvVars(this.servers[serverIndex]);
          if (packagesWithEnvVars.length === 1) {
            const pkg = packagesWithEnvVars[0];
            const packageId = `${serverId}::${pkg.registry_name}::${pkg.package_name}`;
            
            // Use $nextTick to ensure DOM is updated before setting the value
            this.$nextTick(() => {
              this.newConnectionPackageId = packageId;
              
              // Force DOM sync by manually setting the select element value
              setTimeout(() => {
                const packageSelect = document.querySelector('select[x-model="newConnectionPackageId"]');
                if (packageSelect && packageSelect.value !== packageId) {
                  packageSelect.value = packageId;
                  packageSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, 50);
              
              // Initialize credentials for the auto-selected package
              this.initializeCredentialsForPackage(serverId, packageId);
            });
          }
        }
      } catch (error) {
        console.error('Failed to load server packages:', error);
      }
    },
    
    createConnection() {
      if (!this.newConnectionName?.trim() || !this.newConnectionServerId || !this.newConnectionPackageId) {
        this.showToast('Please fill in all required fields', 'error');
        return;
      }
      
      try {
        const connection = Alpine.store('connections').create(
          this.newConnectionName.trim(),
          this.newConnectionServerId,
          this.newConnectionPackageId,
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
      const server = this.servers.find(s => s.id === connection.serverId);
      if (!server) {
        this.showToast('Server not found', 'error');
        return;
      }
      
      // Check if server needs credentials
      if (!this.serverNeedsCredentials(server)) {
        this.showToast('No credentials to configure', 'error');
        return;
      }
      
      // Set up editing state
      this.editingConnection = connection;
      this.editConnectionName = connection.name; // Add connection name to edit
      this.editConnectionCredentials = { ...connection.credentials };
      this.showEditCredentials = {}; // Separate show/hide state for edit modal
      this.showEditConnectionModal = true;
    },
    
    updateConnection() {
      if (!this.editingConnection) return;
      
      try {
        // Update both name and credentials
        Alpine.store('connections').update(this.editingConnection.id, {
          name: this.editConnectionName,
          credentials: this.editConnectionCredentials
        });
        this.showToast(`Connection "${this.editConnectionName}" updated successfully!`);
        this.closeEditConnectionModal();
      } catch (error) {
        console.error('Failed to update connection:', error);
        this.showToast('Failed to update connection', 'error');
      }
    },
    
    closeEditConnectionModal() {
      this.showEditConnectionModal = false;
      this.editingConnection = null;
      this.editConnectionName = '';
      this.editConnectionCredentials = {};
      this.showEditCredentials = {};
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
      // Close server details modal to avoid duplicate text on mobile
      this.selectedServerForDetails = null;
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
    async viewServerDetails(server) {
      // Load full server details including packages and environment variables
      try {
        const fullServer = await database.getServerById(server.id);
        if (fullServer) {
          // Transform the server data to match expected format
          const transformed = await this.transformServersFromDB([fullServer], true);
          this.selectedServerForDetails = transformed[0];
          console.log('Server details loaded:', this.selectedServerForDetails);
        } else {
          this.selectedServerForDetails = server;
        }
      } catch (error) {
        console.error('Failed to load full server details:', error);
        this.selectedServerForDetails = server;
      }
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
        
        // Handle both old format (string) and new format (object)
        bundle.servers = bundle.servers.filter(serverEntry => {
          const id = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
          return id !== serverId;
        });
        bundle.updated = new Date().toISOString();
        Alpine.store('bundles').save();
        
        const server = this.servers.find(s => s.id === serverId);
        this.showToast(`${server?.name || 'Server'} removed from ${bundle.name}`);
        
        // Update selectedBundle if we're viewing details
        // Force reactivity by creating a new object reference
        if (this.selectedBundle && this.selectedBundle.id === bundleId) {
          this.selectedBundle = { ...bundle };
        }
      } catch (error) {
        console.error('Failed to remove server from bundle:', error);
        this.showToast('Failed to remove server', 'error');
      }
    },
    
    getBundleServers(bundle) {
      return (bundle.servers || []).map(serverEntry => {
        // Handle both old format (string) and new format (object)
        const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
        return this.servers.find(s => s.id === serverId);
      }).filter(Boolean);
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
    
    
    // Binary packing utilities for ultra-compact URLs
    packBundle(bundle) {
      try {
        // Truncate name if too long (max 50 chars for reasonable URLs)
        const name = (bundle.name || '').substring(0, 50);
        const nameBytes = new TextEncoder().encode(name);
        
        if (nameBytes.length > 255) {
          throw new Error('Bundle name too long after UTF-8 encoding');
        }
        
        // Get server IDs (use first 8 chars of UUID)
        const serverIds = (bundle.servers || []).map(serverEntry => {
          const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
          return serverId.substring(0, 8); // First 8 hex chars
        });
        
        // Calculate total size: 1 byte name length + 4 bytes timestamp + name + 4 bytes per server
        const totalSize = 1 + 4 + nameBytes.length + (serverIds.length * 4);
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        
        let offset = 0;
        
        // Write name length (1 byte)
        view.setUint8(offset, nameBytes.length);
        offset += 1;
        
        // Write shared timestamp (4 bytes as Unix time)
        const sharedTime = Math.floor(Date.now() / 1000); // Unix timestamp
        view.setUint32(offset, sharedTime, false); // false = big-endian
        offset += 4;
        
        // Write name bytes
        bytes.set(nameBytes, offset);
        offset += nameBytes.length;
        
        // Write server IDs (4 bytes each as big-endian unsigned int)
        for (const serverId of serverIds) {
          const serverInt = parseInt(serverId, 16);
          view.setUint32(offset, serverInt, false); // false = big-endian
          offset += 4;
        }
        
        return bytes;
        
      } catch (error) {
        console.error('Failed to pack bundle:', error);
        throw error;
      }
    },
    
    unpackBundle(binaryData) {
      try {
        const view = new DataView(binaryData.buffer);
        let offset = 0;
        
        // Read name length (1 byte)
        const nameLength = view.getUint8(offset);
        offset += 1;
        
        // Read shared timestamp (4 bytes)
        const sharedTime = view.getUint32(offset, false); // false = big-endian
        offset += 4;
        
        // Read name
        const nameBytes = binaryData.slice(offset, offset + nameLength);
        const name = new TextDecoder().decode(nameBytes);
        offset += nameLength;
        
        // Read server IDs (4 bytes each)
        const servers = [];
        while (offset < binaryData.length) {
          const serverInt = view.getUint32(offset, false); // false = big-endian
          const serverId = serverInt.toString(16).padStart(8, '0');
          servers.push(serverId);
          offset += 4;
        }
        
        return {
          name: name,
          sharedTime: sharedTime,
          servers: servers
        };
        
      } catch (error) {
        console.error('Failed to unpack bundle:', error);
        throw error;
      }
    },
    
    // Sharing methods
    shareBundle(bundle) {
      try {
        // Pack bundle into binary format (ultra-compact)
        const packedData = this.packBundle(bundle);
        
        // Convert to URL-safe Base64 (remove padding for shorter URLs)
        const base64 = btoa(String.fromCharCode(...packedData));
        const urlSafeBase64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        
        // Create ultra-short preview URL
        const baseUrl = `${window.location.origin}${window.location.pathname.replace('index.html', '')}`;
        const previewUrl = `${baseUrl}preview.html#/${urlSafeBase64}`;
        
        // Copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(previewUrl).then(() => {
            this.showToast('Link copied to clipboard!');
          }).catch(() => {
            this.showToast('Failed to copy link', 'error');
          });
        } else {
          // Fallback for older browsers
          this.showToast('Share URL: ' + previewUrl);
        }
        
        // Use native share API if available (mobile)
        if (navigator.share) {
          navigator.share({
            title: `MCP Bundle: ${bundle.name}`,
            text: bundle.description || `Check out this MCP bundle with ${bundle.servers?.length || 0} servers`,
            url: previewUrl
          }).catch(error => {
            console.log('Native share cancelled or failed:', error);
          });
        }
        
        console.log(`Bundle URL length: ${previewUrl.length} chars (was ~600 chars)`);
        
      } catch (error) {
        console.error('Failed to share bundle:', error);
        this.showToast('Failed to create share URL', 'error');
      }
    },
    
    async selectCategory(categoryName) {
      this.selectedCategory = categoryName;
      this.currentPage = 1; // Reset to first page
      this.loading = true;
      
      try {
        let dbServers;
        if (categoryName === 'All Servers') {
          // Load all servers (no limit)
          dbServers = await database.getServers(10000);
        } else {
          // Load servers by category
          dbServers = await database.getServersByCategory(categoryName, 10000);
        }
        
        // Transform database results to match expected format
        this.servers = await this.transformServersFromDB(dbServers);
        console.log(`Loaded ${this.servers.length} servers for category: ${categoryName}`);
      } catch (error) {
        console.error('Failed to load servers by category:', error);
        this.showToast('Failed to load servers', 'error');
      } finally {
        this.loading = false;
      }
    },
    
    // Pagination methods
    nextPage() {
      if (this.currentPage < this.totalPages) {
        this.currentPage++;
      }
    },
    
    previousPage() {
      if (this.currentPage > 1) {
        this.currentPage--;
      }
    },
    
    goToPage(page) {
      if (page >= 1 && page <= this.totalPages) {
        this.currentPage = page;
      }
    },
    
    async importFromURL(encodedData) {
      try {
        const decoded = atob(encodedData.replace(/-/g, '+').replace(/_/g, '/'));
        
        let sharedBundle;
        try {
          // Try parsing as JSON first (old format)
          sharedBundle = JSON.parse(decoded);
        } catch (jsonError) {
          // If JSON parsing fails, try binary format
          const binaryData = new Uint8Array(decoded.split('').map(char => char.charCodeAt(0)));
          sharedBundle = this.unpackBundle(binaryData);
        }
        
        // Validate bundle structure
        if (!sharedBundle.name || !Array.isArray(sharedBundle.servers)) {
          throw new Error('Invalid bundle format');
        }
        
        // Validate that servers exist in our catalogue
        // Handle both old format (string IDs) and new format (server objects)
        // Also handle truncated IDs from binary packing (first 8 chars)
        const validServers = sharedBundle.servers.filter(serverEntry => {
          const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
          return this.servers.find(s => s.id === serverId || s.id.startsWith(serverId));
        });
        
        if (validServers.length === 0) {
          throw new Error('No valid servers found in shared bundle');
        }
        
        // Map server IDs to full server objects
        const serverObjects = validServers.map(serverEntry => {
          const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
          return this.servers.find(s => s.id === serverId || s.id.startsWith(serverId));
        }).filter(Boolean);
        
        // Show preview before importing
        this.importPreview = {
          ...sharedBundle,
          servers: serverObjects,
          invalidServers: sharedBundle.servers.filter(serverEntry => {
            const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
            return !validServers.some(validEntry => {
              const validId = typeof validEntry === 'string' ? validEntry : validEntry.serverId;
              return validId === serverId;
            });
          })
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
        this.importPreview.servers.forEach(serverEntry => {
          const serverId = typeof serverEntry === 'string' ? serverEntry : (serverEntry.serverId || serverEntry.id);
          const packageIndex = typeof serverEntry === 'object' ? serverEntry.packageIndex : 0;
          Alpine.store('bundles').addServer(bundle.id, serverId, packageIndex);
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
      
      bundle.servers.forEach(serverEntry => {
        // Handle both old format (string) and new format (object)
        const serverId = typeof serverEntry === 'string' ? serverEntry : serverEntry.serverId;
        const packageIndex = typeof serverEntry === 'object' ? serverEntry.packageIndex : 0;
        
        const server = this.servers.find(s => s.id === serverId);
        if (!server) return;
        
        // Get the selected package
        const pkg = serverUtils.getPackageByIndex(server, packageIndex);
        if (!pkg) return;
        
        // Build config from package
        const serverConfig = serverUtils.buildPackageConfig(pkg);
        
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
          const requiredSecrets = serverUtils.getRequiredSecrets(pkg);
          requiredSecrets.forEach(secret => {
            if (!serverConfig.env[secret]) {
              serverConfig.env[secret] = `\${${secret}}`;
            }
          });
        }
        
        // Use sanitized server name as key in the config
        const sanitizedName = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        mcpServers[sanitizedName] = serverConfig;
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
    
    
    // New server utils - wrappers for serverUtils
    serverNeedsCredentials(server) {
      return serverUtils.serverNeedsCredentials(server);
    },

    // Check if the selected package for a server needs credentials
    selectedPackageNeedsCredentials(server) {
      if (!server || !server.packages) return false;
      
      const packageIndex = this.selectedPackageIndex[server.id] || 0;
      const pkg = serverUtils.getPackageByIndex(server, packageIndex);
      
      if (!pkg || !pkg.environment_variables) return false;
      
      return pkg.environment_variables.some(v => {
        // If explicitly marked as required and secret, use that
        if (v.is_required === 1 && v.is_secret === 1) {
          return true;
        }
        // Otherwise, check name patterns for likely secrets
        const upper = v.name.toUpperCase();
        const secretPatterns = [
          'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'PWD',
          'AUTH', 'CREDENTIAL', 'API', 'PRIVATE', 'ACCESS'
        ];
        return secretPatterns.some(pattern => upper.includes(pattern));
      });
    },

    serverHasEnvVars(server) {
      if (!server.packages) return false;
      return server.packages.some(pkg => 
        pkg.environment_variables && pkg.environment_variables.length > 0
      );
    },
    
    getPackageDisplayName(pkg) {
      return serverUtils.getPackageDisplayName(pkg);
    },
    
    getSelectedPackage(server) {
      if (!server || !server.id) return null;
      const index = this.selectedPackageIndex[server.id] || 0;
      return serverUtils.getPackageByIndex(server, index);
    },
    
    // Generate package configuration preview
    getPackageConfigPreview(server) {
      const pkg = this.getSelectedPackage(server);
      if (!pkg || !server) return {};
      
      const config = serverUtils.buildPackageConfig(pkg);
      
      // For remote packages, use different top-level structure if needed
      if (pkg.registry_name === 'remote') {
        // Remote packages still use mcpServers but with type/url structure
        return {
          mcpServers: {
            [server.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')]: config
          }
        };
      }
      
      // For file-based packages (npm, pypi, docker), ensure env vars have placeholders
      if (config.env) {
        const requiredSecrets = serverUtils.getRequiredSecrets(pkg);
        requiredSecrets.forEach(secret => {
          if (!config.env[secret]) {
            config.env[secret] = `\${${secret}}`;
          }
        });
      }
      
      return {
        mcpServers: {
          [server.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')]: config
        }
      };
    },

    // Check if a server is official (based on repository ownership)
    isOfficialServer(server) {
      if (!server || !server.repository_url) return false;
      
      // Define official organizations/users that maintain official MCP servers
      const officialOrgs = [
        'modelcontextprotocol',
        'anthropics', 
        'github',
        'microsoft',
        'google',
        'googleapis',
        'awslabs',
        'cloudflare',
        'supabase',
        'supabase-community'
      ];
      
      // Extract owner from repository URL
      const repoPath = server.repository_path || server.repository_url?.replace('https://github.com/', '');
      if (!repoPath) return false;
      
      const owner = repoPath.split('/')[0]?.toLowerCase();
      return officialOrgs.includes(owner);
    },
    
    getPackageSecrets(server, packageIndex) {
      const pkg = serverUtils.getPackageByIndex(server, packageIndex || 0);
      return serverUtils.getRequiredSecrets(pkg);
    },
    
    formatServerName(name) {
      return serverUtils.formatServerName(name);
    },
    
    getPackageEnvVars(server, packageIndex) {
      const pkg = serverUtils.getPackageByIndex(server, packageIndex || 0);
      return serverUtils.getPackageEnvVars(pkg);
    },
    
    cleanParameterName(name) {
      if (!name) return name;
      // Remove content in parentheses, including the parentheses themselves
      return name.replace(/\s*\([^)]*\)\s*/g, '').trim();
    },
    
    // Filter packages to only show those with environment variables
    getPackagesWithEnvVars(server) {
      if (!server || !server.packages) return [];
      return server.packages.filter(pkg => {
        return pkg.environment_variables && pkg.environment_variables.length > 0;
      });
    },
    
    // Filter servers to only show those with at least one package that has environment variables
    getServersWithEnvVars(servers) {
      if (!servers) return [];
      return servers.filter(server => {
        const packagesWithEnvVars = this.getPackagesWithEnvVars(server);
        return packagesWithEnvVars.length > 0;
      });
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
      } else if (hash === '#/connections') {
        // Connections view
        this.currentView = 'connections';
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