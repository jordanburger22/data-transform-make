require('dotenv').config();

const express = require('express');
const axios = require('axios');
const makeRouter = express.Router();

// Kintone Configuration
const KINTONE_DOMAIN = 'https://wattsbags.kintone.com';
const ORDER_APP_ID = process.env.ORDER_APP_ID;
const PROCESS_APP_ID = process.env.PROCESS_APP_ID;
const INVENTORY_APP_ID = process.env.INVENTORY_APP_ID;

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
    headers: { 'X-Cybozu-API-Token': token },
    data
  };
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

function transformToProcessRecords(data, customer, startStatus) {
  const records = [];
  data.order_details_table_website.value.forEach(item => {
    const qty = parseInt(item.value.qty_website.value);
    const bagModel = item.value.bag_model_website.value;
    const inventoryId = item.value.inventory_id.value; // Get inventory_id from the subtable
    for (let i = 0; i < qty; i++) {
      records.push({
        customer: { value: customer },
        bag_model: { value: bagModel },
        inventory_id: { value: inventoryId }, // Pass inventory_id to Order Management App
        Status: { value: startStatus },
        date_ordered: { value: new Date().toISOString().split('T')[0] }
      });
    }
  });
  return records;
}

// Existing WooCommerce Endpoint
makeRouter.post('/process-order', (req, res, next) => {
  try {
    const lineItems = req.body;
    if (!Array.isArray(lineItems)) {
      throw new Error('Invalid data: expected request body to be an array of line items');
    }

    const transformedLineItems = lineItems.map(item => {
      let transformedMetaData = {};
      let currentEmbroideryGroup = null;

      if (Array.isArray(item.metaData)) {
        item.metaData.forEach(meta => {
          if (meta.value && typeof meta.value === 'string' && !meta.valueArray) {
            if (meta.displayKey && meta.displayKey.endsWith("Embroidery Position")) {
              const groupName = meta.displayKey.replace(" Position", "");
              currentEmbroideryGroup = groupName;
              if (!transformedMetaData[currentEmbroideryGroup]) transformedMetaData[currentEmbroideryGroup] = {};
              transformedMetaData[currentEmbroideryGroup]["Position"] = meta.value;
            } else if (
              meta.displayKey === "Line 1" ||
              meta.displayKey === "Line 1 Text Font" ||
              meta.displayKey === "Line 2" ||
              meta.displayKey === "Line 2 Text Font"
            ) {
              if (currentEmbroideryGroup) transformedMetaData[currentEmbroideryGroup][meta.displayKey] = meta.value;
              else transformedMetaData[meta.displayKey] = meta.value;
            } else {
              transformedMetaData[meta.displayKey] = meta.value;
            }
          }
        });
      }

      return {
        ID: item.id,
        Name: item.name,
        productId: item.productId,
        Quantity: item.quantity,
        Subtotal: item.subtotal,
        Total: item.total,
        Taxes: item.taxes,
        MetaData: transformedMetaData
      };
    });

    const finalOrderObject = { order: transformedLineItems };
    const simpleRecords = transformToSimpleRecords(finalOrderObject);
    return res.status(200).json(simpleRecords);
  } catch (error) {
    next(error);
  }
});

// Order Approval Webhook
makeRouter.post('/order-webhook', async (req, res, next) => {
  try {
    const { record } = req.body;
    if (record.Status.value !== 'Approved') return res.sendStatus(200);

    const customer = `${record.first_name.value} ${record.last_name.value} - ${record.company_name.value}`;
    const bagDetails = record.order_details_table_website.value;

    for (const item of bagDetails) {
      const qty = parseInt(item.value.qty_website.value);
      const bagModel = item.value.bag_model_website.value;
      const inventoryId = item.value.inventory_id.value; // Get inventory_id from the subtable

      if (!inventoryId) {
        throw new Error(`No inventory_id found for bag model: ${bagModel}. Please ensure the Lookup field is set.`);
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
    }

    const processRecords = transformToProcessRecords(record, customer, 'Office');
    await kintoneRequest('POST', `/v1/records.json?app=${PROCESS_APP_ID}`, {
      records: processRecords
    }, PROCESS_APP_ID);

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

// Process Webhook (Bag Movement)
makeRouter.post('/process-webhook', async (req, res, next) => {
  try {
    const { record } = req.body;
    const currentStatus = record.Status.value;
    const bagModel = record.bag_model.value;
    const inventoryId = record.inventory_id.value; // Get inventory_id from the Order Management App record
    const previousStatus = record.Previous_Status?.value;
    if (!previousStatus || previousStatus === currentStatus) return res.sendStatus(200);

    if (!inventoryId) {
      throw new Error(`No inventory_id found for bag model: ${bagModel}`);
    }

    // Fetch the full inventory record by ID
    const inventoryRes = await kintoneRequest('GET', `/v1/record.json?app=${INVENTORY_APP_ID}&id=${inventoryId}`, {}, INVENTORY_APP_ID);
    const inventory = inventoryRes.data.record;

    const statusMap = {
      'Office': 'qty_office',
      'Warehouse': 'qty_warehouse',
      'Art': 'qty_art',
      'Cutting': 'qty_cutting',
      'Need Sewer Assigned': 'qty_sewer',
      'Sewer Assigned': 'qty_sewer',
      'Sewer Pickup Ready': 'qty_sewer',
      'With Sewer': 'qty_sewer',
      'Embroidery': 'qty_embroidery',
      'Complete': null
    };

    const update = {};

    if (statusMap[previousStatus]) {
      const currentQty = parseInt(inventory[statusMap[previousStatus]].value || 0);
      update[statusMap[previousStatus]] = { value: currentQty - 1 };
    }
    if (statusMap[currentStatus]) {
      const currentQty = parseInt(inventory[statusMap[currentStatus]].value || 0);
      update[statusMap[currentStatus]] = { value: currentQty + 1 };
    }
    if (currentStatus === 'Complete') {
      const currentCompleted = parseInt(inventory.qty_completed.value || 0);
      update.qty_completed = { value: currentCompleted + 1 };
    }

    await kintoneRequest('PUT', `/v1/record.json`, {
      app: INVENTORY_APP_ID,
      id: inventoryId,
      record: update
    }, INVENTORY_APP_ID);

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

module.exports = makeRouter;