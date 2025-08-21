// Utility functions for working with official MCP registry format

// Helper to detect if an env var name is likely a secret
function isLikelySecret(name) {
  if (!name) return false;
  const upper = name.toUpperCase();
  const secretPatterns = [
    'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'PWD',
    'AUTH', 'CREDENTIAL', 'API', 'PRIVATE', 'ACCESS'
  ];
  return secretPatterns.some(pattern => upper.includes(pattern));
}

// Extract secrets that need user input
export function getRequiredSecrets(pkg) {
  if (!pkg || !pkg.environment_variables) return [];
  
  return pkg.environment_variables
    .filter(v => {
      // If explicitly marked as required and secret, use that
      if (v.is_required === 1 && v.is_secret === 1) {
        return true;
      }
      // Otherwise, always check name patterns for likely secrets
      return isLikelySecret(v.name);
    })
    .map(v => v.name);
}

// Get all required environment variables (secrets and non-secrets)
export function getRequiredEnvVars(pkg) {
  if (!pkg || !pkg.environment_variables) return [];
  
  return pkg.environment_variables
    .filter(v => v.is_required)
    .map(v => ({
      name: v.name,
      description: v.description,
      isSecret: v.is_secret,
      default: v.default,
      choices: v.choices
    }));
}

// Build command configuration from package
export function buildPackageConfig(pkg) {
  // Handle remote/HTTP packages differently
  if (pkg.registry_name === 'remote') {
    return buildRemotePackageConfig(pkg);
  }
  
  // Handle Docker packages with proper arguments
  if (pkg.registry_name === 'docker') {
    return buildDockerPackageConfig(pkg);
  }
  
  // Handle npm/pypi packages (existing logic)
  const command = pkg.runtime_hint || getDefaultRuntime(pkg.registry_name);
  const args = buildPackageArgs(pkg);
  const env = buildPackageEnv(pkg.environment_variables);
  
  return { command, args, env };
}

// Build configuration for remote/HTTP packages
export function buildRemotePackageConfig(pkg) {
  // Find the URL from package arguments
  const urlArg = pkg.package_arguments?.find(arg => arg.type === 'url' && arg.name === 'endpoint');
  const url = urlArg?.value || getKnownRemoteURL(pkg.package_name) || 'https://example.com/mcp';
  
  // Determine if it's HTTP or SSE (default to HTTP)
  const type = pkg.package_arguments?.find(arg => arg.name === 'type')?.value || 'http';
  
  const config = {
    type: type,
    url: url
  };
  
  // Add headers if authentication is needed
  const headers = buildAuthHeaders(pkg.environment_variables, pkg.package_arguments);
  if (Object.keys(headers).length > 0) {
    config.headers = headers;
  }
  
  return config;
}

// Build configuration for Docker packages
export function buildDockerPackageConfig(pkg) {
  const args = buildDockerArgs(pkg);
  const env = buildPackageEnv(pkg.environment_variables);
  
  return {
    command: 'docker',
    args: args,
    env: env
  };
}

// Build Docker run arguments from stored package arguments
export function buildDockerArgs(pkg) {
  // If we have stored package arguments, use them
  if (pkg.package_arguments && pkg.package_arguments.length > 0) {
    const positionalArgs = pkg.package_arguments
      .filter(arg => arg.type === 'positional')
      .sort((a, b) => a.id - b.id) // Ensure correct order
      .map(arg => arg.value);
    
    if (positionalArgs.length > 0) {
      return positionalArgs;
    }
  }
  
  // Fallback: build arguments manually
  const args = ['run', '-i', '--rm'];
  
  // Add environment variable flags
  if (pkg.environment_variables) {
    pkg.environment_variables.forEach(env => {
      if (env.is_required || env.is_secret) {
        args.push('-e', env.name);
      }
    });
  }
  
  // Add the Docker image
  args.push(pkg.package_name);
  
  return args;
}

// Build authentication headers for remote packages
export function buildAuthHeaders(envVars = [], packageArgs = []) {
  const headers = {};
  
  // Check package arguments for stored headers
  if (packageArgs) {
    const headerArgs = packageArgs.filter(arg => arg.type === 'header');
    headerArgs.forEach(arg => {
      // Convert placeholder values to environment variable substitution
      let value = arg.value;
      if (value && (value.includes('YOUR_') || value.includes('API_KEY') || value.includes('TOKEN'))) {
        // Find matching environment variable
        const matchingEnvVar = envVars.find(env => 
          env.name === value || 
          env.name.includes(value.replace('YOUR_', '')) ||
          value.includes(env.name)
        );
        if (matchingEnvVar) {
          value = `\${${matchingEnvVar.name}}`;
        }
      }
      headers[arg.name] = value;
    });
  }
  
  // If no stored headers, infer from environment variables
  if (Object.keys(headers).length === 0 && envVars) {
    envVars.forEach(env => {
      if (env.is_secret && env.name) {
        const envName = env.name.toUpperCase();
        if (envName.includes('TOKEN') || envName.includes('KEY')) {
          headers['Authorization'] = `Bearer \${${env.name}}`;
        }
      }
    });
  }
  
  return headers;
}

// Get known remote URLs for recognized services
export function getKnownRemoteURL(packageName) {
  const knownUrls = {
    'github': 'https://api.githubcopilot.com/mcp/',
    'https://api.githubcopilot.com/mcp/': 'https://api.githubcopilot.com/mcp/',
    // Add more known URLs as needed
  };
  
  return knownUrls[packageName] || null;
}

// Get default runtime for registry type
export function getDefaultRuntime(registryName) {
  const runtimeMap = {
    'npm': 'npx',
    'pypi': 'uvx', 
    'docker': 'docker',
    'nuget': 'dnx'
  };
  return runtimeMap[registryName] || 'npx';
}

// Build args array from package (for non-Docker packages)
export function buildPackageArgs(pkg) {
  const args = [];
  
  // Use stored package arguments - no hardcoded logic
  // The validation script stores necessary parameters in the database
  if (pkg.package_arguments) {
    pkg.package_arguments
      .filter(arg => arg.type === 'named' || (arg.type === 'positional' && !['run', '-i', '--rm', '-e'].includes(arg.value)))
      .forEach(arg => {
        if (arg.type === 'named') {
          args.push(arg.name);
          if (arg.value) {
            args.push(arg.value);
          }
        } else if (arg.type === 'positional') {
          args.push(arg.value);
        }
      });
  }
  
  // Ensure package name is included (unless it's already in the stored arguments)
  const packageName = pkg.package_name || pkg.name;
  if (packageName && !args.includes(packageName)) {
    args.push(packageName);
  }
  
  // Fallback: if no arguments at all, use package name only
  if (args.length === 0) {
    args.push(packageName);
  }
  
  return args;
}

// Replace variables in value string
function replaceVariables(value, variables) {
  if (!variables) return value;
  
  let result = value;
  Object.keys(variables).forEach(key => {
    const variable = variables[key];
    const placeholder = variable.default || variable.value || `<${key}>`;
    result = result.replace(`{${key}}`, placeholder);
  });
  
  return result;
}

// Build environment object from environment_variables
export function buildPackageEnv(envVars) {
  const env = {};
  
  if (!envVars) return env;
  
  envVars.forEach(v => {
    if (v.is_required) {
      // Use placeholder format for required secrets
      env[v.name] = v.is_secret ? `\${${v.name}}` : (v.default || `\${${v.name}}`);
    } else if (v.default) {
      // Include optional vars with defaults
      env[v.name] = v.default;
    }
  });
  
  return env;
}

// Check if server needs credentials (has any required secrets)
export function serverNeedsCredentials(server) {
  if (!server || !server.packages) return false;
  
  return server.packages.some(pkg => 
    pkg.environment_variables?.some(v => {
      // If explicitly marked as required and secret, use that
      if (v.is_required === 1 && v.is_secret === 1) {
        return true;
      }
      // Otherwise, always check name patterns for likely secrets
      return isLikelySecret(v.name);
    })
  );
}

// Get display name for package
export function getPackageDisplayName(pkg) {
  if (!pkg) return 'Unknown';
  
  const runtime = pkg.runtime_hint || getDefaultRuntime(pkg.registry_name);
  const version = pkg.version ? ` v${pkg.version}` : '';
  
  return `${pkg.registry_name.toUpperCase()} (${runtime})${version}`;
}

// Select the best package for the user's environment
export function selectDefaultPackage(packages) {
  if (!packages || packages.length === 0) return 0;
  
  // Prefer npm for web environment
  const npmIndex = packages.findIndex(p => p.registry_name === 'npm');
  if (npmIndex !== -1) return npmIndex;
  
  // Then Docker
  const dockerIndex = packages.findIndex(p => p.registry_name === 'docker');
  if (dockerIndex !== -1) return dockerIndex;
  
  // Then Python
  const pypiIndex = packages.findIndex(p => p.registry_name === 'pypi');
  if (pypiIndex !== -1) return pypiIndex;
  
  // Default to first
  return 0;
}

// Extract all environment variables for a package
export function getPackageEnvVars(pkg) {
  if (!pkg || !pkg.environment_variables) return [];
  
  return pkg.environment_variables.map(v => ({
    name: v.name,
    description: v.description || '',
    isRequired: v.is_required || false,
    isSecret: v.is_secret || false,
    default: v.default || '',
    choices: v.choices || [],
    format: v.format || 'string'
  }));
}

// Get package by index with fallback
export function getPackageByIndex(server, index) {
  if (!server || !server.packages || server.packages.length === 0) {
    return null;
  }
  
  const idx = index || 0;
  return server.packages[idx] || server.packages[0];
}

// Format server name for display
export function formatServerName(name) {
  if (!name) return 'Unknown';
  
  // Get the part after the last slash
  const lastPart = name.split('/').pop();
  
  // Split by dash and capitalize each word
  return lastPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}