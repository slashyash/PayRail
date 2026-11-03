import { api, ApiError } from './api.js';
export async function decideAndRecover(path, body, recordPath, expected, matches = () => true) {
  try { return await api.post(path, body); }
  catch (error) {
    if (error.status > 0 && error.status < 500) throw error;
    try {
      const current = await api.get(recordPath);
      if (current.status === expected && matches(current)) return current;
      throw new ApiError(0, 'outcome_unknown', `Latest recorded status: ${current.status}. The original request may still be processing. Refresh and inspect this record before retrying.`);
    } catch (readError) {
      if (readError.code === 'outcome_unknown') throw readError;
      throw new ApiError(0, 'outcome_unknown', 'The response was lost and the current status could not be checked. Refresh and inspect this record before retrying.');
    }
  }
}
