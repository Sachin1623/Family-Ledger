import CryptoJS from 'crypto-js';

const SECRET_KEY = 'family-ledger-secure-layer-v1';

/**
 * Encrypts a string value using AES
 */
export const encryptPII = (value: string | null | undefined): string => {
  if (!value) return '';
  try {
    return CryptoJS.AES.encrypt(value, SECRET_KEY).toString();
  } catch (error) {
    console.error('Encryption error:', error);
    return value || '';
  }
};

/**
 * Decrypts a string value using AES
 */
export const decryptPII = (encryptedValue: string | null | undefined): string => {
  if (!encryptedValue) return '';
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedValue, SECRET_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted || encryptedValue || '';
  } catch (error) {
    // If decryption fails, it might be clear text or a different key
    return encryptedValue || '';
  }
};
