require('dotenv').config();

const express = require('express');
const axios = require('axios');
const makeRouter = express.Router();

// Kintone Configuration
const KINTONE_DOMAIN = 'https://wattsbags.kintone.com';
const ORDER_APP_ID = parseInt(process.env.ORDER_APP_ID, 10);
const PROCESS_APP_ID = parseInt(process.env.PROCESS_APP_ID, 10);
const INVENTORY_APP_ID = parseInt(process.env.INVENTORY_APP_ID, 10);

// API Tokens from environment variables
const API_TOKENS = {
  [ORDER_APP_ID]: process.env.ORDER_APP_TOKEN,
  [PROCESS_APP_ID]: process.env.PROCESS_APP_TOKEN,
  [INVENTORY_APP_ID]: process.env.INVENTORY_APP_TOKEN
};

async function kintoneRequest(method, endpoint, data = {}, appId) {
  const token = API_TOKENS[appId];
  if (!token) {
    throw new Error(`No API token found for app ID ${appId}`);
  }

  const config = {
    method,
    url: `${KINTONE_DOMAIN}/k${endpoint}`, // Using /k/v1/ endpoints
    headers: { 'X-Cybozu-API-Token': token }
  };

  // Only include the data field for non-GET requests
  if (method.toUpperCase() !== 'GET') {
    config.data = data;
  }

  return axios(config);
}

function combineEmbroideryInfo(metaData) {
  let combined = '';
  for (const key in metaData) {
    const group = metaData[key];
    if (group && typeof group === 'object' && group.Position) {
      let groupText = `${key}:\n`;
      for (const subKey in group) {
        if (group[subKey] === "No") continue;
        groupText += `  ${subKey}: ${group[subKey]}\n`;
      }
      if (groupText.trim()) combined += groupText + "\n";
    }
  }
  return combined.trim();
}

function transformToSimpleRecords(finalOrderObject) {
  return finalOrderObject.order.map(item => {
    const embroideryInfo = combineEmbroideryInfo(item.MetaData);
    return {
      product_id: item.productId,
      bag_lookup_website: `${item.productId} - ${item.MetaData["Color Selection"] || ""}`,
      bag_model_website: item.Name,
      bag_color_website: item.MetaData["Color Selection"] || "",
      qty_website: String(item.Quantity),
      rate_website: item.Subtotal,
      total_website: item.Total,
      rigid_lightened_website: item.MetaData["Rigid or Lightened Selection"] || "",
      divider_website: item.MetaData["Divider Option Selection"] || "",
      wheel_option_website: item.MetaData["Wheel Type"] || "",
      logo_website: item.MetaData["Company Logo"] || "",
      order_details_website: embroideryInfo,
      notes_website: item.MetaData["Additional Notes"] || ""
    };
  });
}

// Order Approval Webhook
makeRouter.post('/order-webhook', async (req, res, next) => {
  try {
    const { record } = req.body;
    if (record.Status.value !== 'Approved') return res.sendStatus(200);

    const bagDetails = record.order_details_table_website.value;

    // Track which inventory records have been updated to avoid duplicate updates
    const updatedInventoryIds = new Set();

    for (const item of bagDetails) {
      const qty = parseInt(item.value.qty_website.value);
      const bagModel = item.value.bag_model_website.value;
      const inventoryId = item.value.inventory_id.value; // Get inventory_id from the subtable

      // Skip rows that are empty or missing required fields
      if (!inventoryId || !bagModel || !qty) {
        continue; // Skip this row
      }

      // Skip if this inventory record has already been updated
      if (updatedInventoryIds.has(inventoryId)) {
        continue;
      }

      // Fetch the full inventory record by ID
      const inventoryRes = await kintoneRequest('GET', `/v1/record.json?app=${INVENTORY_APP_ID}&id=${inventoryId}`, {}, INVENTORY_APP_ID);
      const inventory = inventoryRes.data.record;

      const stockLevels = {
        'general_stock_qty': parseInt(inventory.general_stock_qty.value || 0)
      };

      if (stockLevels.general_stock_qty < qty) {
        throw new Error(`Insufficient stock for ${bagModel} in general stock`);
      }

      const update = {
        general_stock_qty: { value: stockLevels.general_stock_qty - qty },
        qty_office: { value: parseInt(inventory.qty_office.value || 0) + qty }
      };

      await kintoneRequest('PUT', `/v1/record.json`, {
        app: INVENTORY_APP_ID,
        id: inventoryId,
        record: update
      }, INVENTORY_APP_ID);

      // Mark this inventory record as updated
      updatedInventoryIds.add(inventoryId);
    }

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

// Process Webhook (Bag Movement)
makeRouter.post('/process-webhook', async (req, res, next) => {
  try {
    console.log('Received /process-webhook request:', JSON.stringify(req.body, null, 2));

    const { record } = req.body;
    const currentStatus = record.Status.value;
    const bagModel = record.bag_model.value;
    const inventoryId = record.inventory_id.value; // Get inventory_id from the Order Management App record
    const previousStatus = record.Previous_Status?.value;

    console.log(`Current Status: ${currentStatus}, Previous Status: ${previousStatus}, Inventory ID: ${inventoryId}, Bag Model: ${bagModel}`);

    if (!previousStatus || previousStatus === currentStatus) {
      console.log('Skipping update: previousStatus is undefined or matches currentStatus');
      return res.sendStatus(200);
    }

    if (!inventoryId) {
      console.log('Error: No inventory_id found');
      throw new Error(`No inventory_id found for bag model: ${bagModel}`);
    }

    // Fetch the full inventory record by ID
    const inventoryRes = await kintoneRequest('GET', `/v1/record.json?app=${INVENTORY_APP_ID}&id=${inventoryId}`, {}, INVENTORY_APP_ID);
    const inventory = inventoryRes.data.record;

    console.log('Fetched inventory record:', JSON.stringify(inventory, null, 2));

    const statusMap = {
      'Office': 'qty_office',
      'Warehouse': 'qty_warehouse',
      'Art': 'qty_art',
      'Cutting': 'qty_embroidery', // Map Cutting to Embroidery inventory
      'Need Sewer Assigned': 'qty_sewer',
      'Sewer Assigned': 'qty_sewer',
      'Sewer Pickup': 'qty_sewer', // Map Sewer Pickup to Sewer inventory
      'With Sewer': 'qty_sewer',
      'Embroidery': 'qty_embroidery',
      'Complete': null
    };

    const update = {};

    if (statusMap[previousStatus]) {
      const currentQty = parseInt(inventory[statusMap[previousStatus]].value || 0);
      update[statusMap[previousStatus]] = { value: currentQty - 1 };
      console.log(`Decreasing ${statusMap[previousStatus]} from ${currentQty} to ${currentQty - 1}`);
    }
    if (statusMap[currentStatus]) {
      const currentQty = parseInt(inventory[statusMap[currentStatus]].value || 0);
      update[statusMap[currentStatus]] = { value: currentQty + 1 };
      console.log(`Increasing ${statusMap[currentStatus]} from ${currentQty} to ${currentQty + 1}`);
    }
    if (currentStatus === 'Complete') {
      const currentCompleted = parseInt(inventory.qty_completed.value || 0);
      update.qty_completed = { value: currentCompleted + 1 };
      console.log(`Increasing qty_completed from ${currentCompleted} to ${currentCompleted + 1}`);
    }

    console.log('Updating inventory with:', JSON.stringify(update, null, 2));

    await kintoneRequest('PUT', `/v1/record.json`, {
      app: INVENTORY_APP_ID,
      id: inventoryId,
      record: update
    }, INVENTORY_APP_ID);

    console.log('Inventory update successful');

    res.sendStatus(200);
  } catch (error) {
    console.error('Error in /process-webhook:', error);
    next(error);
  }
});

module.exports = makeRouter;