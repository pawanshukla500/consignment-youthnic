/**
 * Inventory planning emails: daily scheduler + manual only (not per-consignment).
 */
const assert = require('assert');
const { allowsAutomaticEmail } = require('../utils/inventoryNotify');
const { DEFAULT_INVENTORY_SETTINGS } = require('../utils/inventorySettings');

assert.strictEqual(allowsAutomaticEmail('daily_report', false), true);
assert.strictEqual(allowsAutomaticEmail('manual', false), true);
assert.strictEqual(allowsAutomaticEmail('new_shortage', false), false);
assert.strictEqual(allowsAutomaticEmail('new_shortage', true), true);
assert.strictEqual(allowsAutomaticEmail('quantity_change', false), false);
assert.strictEqual(allowsAutomaticEmail('sync_shortage', false), false);
assert.strictEqual(allowsAutomaticEmail('critical_urgent', false), false);

assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.emailOnNewShortage, false);
assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.emailDailyReport, true);
assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.emailAfterDailySync, true);
assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.syncHourLocal, 10);
assert.strictEqual(DEFAULT_INVENTORY_SETTINGS.syncMinuteLocal, 30);

console.log('Inventory email policy tests passed.');
