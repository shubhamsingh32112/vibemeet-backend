import mongoose from 'mongoose';

/**
 * Normalize a MongoDB ObjectId to a string
 * Handles both ObjectId instances and populated documents
 * 
 * @param id - Can be ObjectId, User document (with _id), or string
 * @returns Normalized string representation of the ID
 */
export function normalizeId(id: any): string {
  if (!id) {
    throw new Error('Cannot normalize null or undefined ID');
  }
  
  // If it's already a string, return it
  if (typeof id === 'string') {
    return id;
  }
  
  // If it's a populated document (has _id property), extract _id
  if (id._id) {
    return id._id.toString();
  }
  
  // If it's an ObjectId instance, convert to string
  if (id instanceof mongoose.Types.ObjectId) {
    return id.toString();
  }
  
  // If it has toString method, use it
  if (typeof id.toString === 'function') {
    return id.toString();
  }
  
  throw new Error(`Cannot normalize ID: ${JSON.stringify(id)}`);
}

/**
 * Compare two IDs for equality
 * Normalizes both IDs before comparison
 * 
 * @param id1 - First ID (ObjectId, User document, or string)
 * @param id2 - Second ID (ObjectId, User document, or string)
 * @returns true if IDs match, false otherwise
 */
export function idsMatch(id1: any, id2: any): boolean {
  try {
    const normalized1 = normalizeId(id1);
    const normalized2 = normalizeId(id2);
    return normalized1 === normalized2;
  } catch (error) {
    console.error('❌ [ID UTILS] Error comparing IDs:', error);
    return false;
  }
}

/**
 * Get normalized ID for logging/debugging
 * Returns a safe string representation
 */
export function getIdForLogging(id: any): string {
  try {
    return normalizeId(id);
  } catch (error) {
    return `[INVALID_ID: ${JSON.stringify(id)}]`;
  }
}
