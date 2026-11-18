import { createBillingHandler } from '../../server/billing.js';
export const createCheckoutHandler = dependencies => createBillingHandler('checkout', dependencies);
export default createCheckoutHandler();
