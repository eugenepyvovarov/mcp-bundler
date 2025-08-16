// Web Crypto API utilities for secure credential storage
// Following Section 5.1 - Credential Protection

// Check if Web Crypto API is available
const cryptoAvailable = () => {
  return window.crypto && 
         window.crypto.subtle && 
         typeof window.crypto.getRandomValues === 'function';
};

// Generate secure random bytes
const generateRandomBytes = (length = 16) => {
  if (!cryptoAvailable()) {
    throw new Error('Web Crypto API not available');
  }
  
  const array = new Uint8Array(length);
  window.crypto.getRandomValues(array);
  return array;
};

// Convert ArrayBuffer to Base64 string
const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

// Convert Base64 string to ArrayBuffer
const base64ToArrayBuffer = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// Derive encryption key from passphrase using PBKDF2
const deriveKey = async (passphrase, salt, iterations = 100000) => {
  if (!cryptoAvailable()) {
    throw new Error('Web Crypto API not available');
  }
  
  try {
    // Import the passphrase as a raw key
    const passphraseKey = await window.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );
    
    // Derive the encryption key using PBKDF2
    const key = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: iterations,
        hash: 'SHA-256'
      },
      passphraseKey,
      { 
        name: 'AES-GCM', 
        length: 256 
      },
      false,
      ['encrypt', 'decrypt']
    );
    
    return key;
  } catch (error) {
    console.error('Key derivation failed:', error);
    throw new Error('Failed to derive encryption key');
  }
};

// Encrypt data using AES-GCM
const encryptData = async (data, key) => {
  if (!cryptoAvailable()) {
    throw new Error('Web Crypto API not available');
  }
  
  try {
    // Generate random initialization vector
    const iv = generateRandomBytes(12); // 96-bit IV for GCM
    
    // Encrypt the data
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      key,
      new TextEncoder().encode(JSON.stringify(data))
    );
    
    return {
      encrypted: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(iv)
    };
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
};

// Decrypt data using AES-GCM
const decryptData = async (encryptedData, key, iv) => {
  if (!cryptoAvailable()) {
    throw new Error('Web Crypto API not available');
  }
  
  try {
    // Decrypt the data
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToArrayBuffer(iv)
      },
      key,
      base64ToArrayBuffer(encryptedData)
    );
    
    // Convert back to string and parse JSON
    const decryptedText = new TextDecoder().decode(decrypted);
    return JSON.parse(decryptedText);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw new Error('Failed to decrypt data - invalid passphrase or corrupted data');
  }
};

// Crypto Store for Alpine.js
document.addEventListener('alpine:init', () => {
  Alpine.store('crypto', {
    // Check if crypto is available
    isAvailable: cryptoAvailable(),
    
    // Generate random salt
    generateSalt() {
      return arrayBufferToBase64(generateRandomBytes(16));
    },
    
    // Generate random password
    generatePassword(length = 16) {
      const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      const randomBytes = generateRandomBytes(length);
      let password = '';
      
      for (let i = 0; i < length; i++) {
        password += charset[randomBytes[i] % charset.length];
      }
      
      return password;
    },
    
    // Encrypt credentials with passphrase
    async encrypt(data, passphrase) {
      if (!this.isAvailable) {
        throw new Error('Web Crypto API not available');
      }
      
      if (!passphrase || passphrase.length < 8) {
        throw new Error('Passphrase must be at least 8 characters long');
      }
      
      try {
        // Generate random salt
        const salt = generateRandomBytes(16);
        
        // Derive encryption key
        const key = await deriveKey(passphrase, salt);
        
        // Encrypt the data
        const encrypted = await encryptData(data, key);
        
        // Return encrypted package
        return {
          version: '1.0',
          algorithm: 'AES-GCM',
          keyDerivation: 'PBKDF2',
          iterations: 100000,
          salt: arrayBufferToBase64(salt),
          iv: encrypted.iv,
          data: encrypted.encrypted,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        console.error('Encryption error:', error);
        throw error;
      }
    },
    
    // Decrypt credentials with passphrase
    async decrypt(encryptedPackage, passphrase) {
      if (!this.isAvailable) {
        throw new Error('Web Crypto API not available');
      }
      
      if (!encryptedPackage || typeof encryptedPackage !== 'object') {
        throw new Error('Invalid encrypted data');
      }
      
      if (!passphrase) {
        throw new Error('Passphrase is required');
      }
      
      try {
        // Extract encryption parameters
        const { salt, iv, data, iterations = 100000 } = encryptedPackage;
        
        if (!salt || !iv || !data) {
          throw new Error('Missing encryption parameters');
        }
        
        // Derive decryption key
        const key = await deriveKey(passphrase, base64ToArrayBuffer(salt), iterations);
        
        // Decrypt the data
        const decrypted = await decryptData(data, key, iv);
        
        return decrypted;
      } catch (error) {
        console.error('Decryption error:', error);
        throw error;
      }
    },
    
    // Hash passphrase for verification (without storing)
    async hashPassphrase(passphrase, salt = null) {
      if (!this.isAvailable) {
        throw new Error('Web Crypto API not available');
      }
      
      try {
        // Use provided salt or generate new one
        const saltBuffer = salt ? base64ToArrayBuffer(salt) : generateRandomBytes(16);
        
        // Create hash using PBKDF2
        const passphraseKey = await window.crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(passphrase),
          { name: 'PBKDF2' },
          false,
          ['deriveBits']
        );
        
        const hashBits = await window.crypto.subtle.deriveBits(
          {
            name: 'PBKDF2',
            salt: saltBuffer,
            iterations: 100000,
            hash: 'SHA-256'
          },
          passphraseKey,
          256
        );
        
        return {
          hash: arrayBufferToBase64(hashBits),
          salt: arrayBufferToBase64(saltBuffer)
        };
      } catch (error) {
        console.error('Hashing error:', error);
        throw new Error('Failed to hash passphrase');
      }
    },
    
    // Verify passphrase against hash
    async verifyPassphrase(passphrase, storedHash, salt) {
      try {
        const computed = await this.hashPassphrase(passphrase, salt);
        return computed.hash === storedHash;
      } catch (error) {
        console.error('Verification error:', error);
        return false;
      }
    },
    
    // Secure string comparison (timing-attack resistant)
    secureCompare(a, b) {
      if (a.length !== b.length) {
        return false;
      }
      
      let result = 0;
      for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
      }
      
      return result === 0;
    },
    
    // Generate secure random ID
    generateId(length = 16) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const randomBytes = generateRandomBytes(length);
      let id = '';
      
      for (let i = 0; i < length; i++) {
        id += chars[randomBytes[i] % chars.length];
      }
      
      return id;
    },
    
    // Test crypto functionality
    async test() {
      if (!this.isAvailable) {
        return { success: false, error: 'Web Crypto API not available' };
      }
      
      try {
        const testData = { test: 'Hello, World!', timestamp: Date.now() };
        const testPassphrase = 'test-passphrase-123';
        
        // Test encryption
        const encrypted = await this.encrypt(testData, testPassphrase);
        
        // Test decryption
        const decrypted = await this.decrypt(encrypted, testPassphrase);
        
        // Verify data integrity
        const success = JSON.stringify(testData) === JSON.stringify(decrypted);
        
        return { 
          success, 
          encrypted: !!encrypted.data,
          decrypted: !!decrypted,
          dataIntegrity: success
        };
      } catch (error) {
        return { 
          success: false, 
          error: error.message 
        };
      }
    }
  });
});

// Utility functions for credential validation
const validateCredential = (credential, type = 'token') => {
  if (!credential || typeof credential !== 'string') {
    return { valid: false, error: 'Credential must be a non-empty string' };
  }
  
  switch (type) {
    case 'token':
      // Generic token validation (GitHub, API keys, etc.)
      if (credential.length < 10) {
        return { valid: false, error: 'Token appears too short' };
      }
      break;
      
    case 'password':
      // Password strength validation
      if (credential.length < 8) {
        return { valid: false, error: 'Password must be at least 8 characters' };
      }
      break;
      
    case 'url':
      // URL validation
      try {
        new URL(credential);
      } catch {
        return { valid: false, error: 'Invalid URL format' };
      }
      break;
      
    case 'email':
      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(credential)) {
        return { valid: false, error: 'Invalid email format' };
      }
      break;
  }
  
  return { valid: true };
};

// Sanitize credential input (prevent XSS)
const sanitizeCredential = (credential) => {
  if (typeof credential !== 'string') {
    return '';
  }
  
  // Remove potentially dangerous characters
  return credential
    .replace(/[<>'"&]/g, '') // Remove HTML/XML special chars
    .trim(); // Remove whitespace
};

// Export utilities for use in other modules
window.MCPCrypto = {
  validate: validateCredential,
  sanitize: sanitizeCredential,
  available: cryptoAvailable
};

console.log('Crypto utilities initialized. Available:', cryptoAvailable());