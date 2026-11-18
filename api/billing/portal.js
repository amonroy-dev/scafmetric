import { createBillingHandler } from '../../server/billing.js';
export const createPortalHandler = dependencies => createBillingHandler('portal', dependencies);
export default createPortalHandler();
