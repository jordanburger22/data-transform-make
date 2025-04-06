const express = require('express');
const axios = require('axios');
const makeRouter = express.Router();

// Kintone Configuration
const KINTONE_DOMAIN = 'https://wattsbags.kintone.com';
const ORDER_APP_ID = '13';
const PROCESS_APP_ID = '23';
const INVENTORY_APP_ID = '11';
const API_TOKEN = 'gHoZ02FI3jbrUCBx5Y3yifsvwBgfvwKWnC4nBHZm';

async function kintoneRequest(method, endpoint, data = {}) {
  const config = {
    method,
    url: `${KINTONE_DOMAIN}${endpoint}`,
    headers: { 'X-Cybozu-API-Token': API_TOKEN },
    data
  };
  return axios(config);
}

/**
 * Combines embroidery group information from the metaData object into a single multi-line string.
 * For each embroidery group (determined by the presence of a "Position" property),
 * the function formats all the key/value pairs in that group, skipping any where the value is "No".
 */
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

/**
 * Transforms the final order object into an array of simplified records suitable for Kintone,
 * where each key maps directly to its value.
 */
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
    for (let i = 0; i < qty; i++) {
      records.push({
        customer: { value: customer },
        bag_model: { value: bagModel },
        Status: { value: startStatus },
        date_ordered: { value: new Date().toISOString().split('T')[0] }
      });
    }
  });
  return records;
}

function updateBreakdown(inventory, category, field, delta) {
  const breakdown = inventory.inventory_breakdown.value;
  let row = breakdown.find(r => r.value.category.value === category);
  if (!row) {
    row = { value: { category: { value: category }, qty_total: { value: "0" }, qty_warehouse: { value: "0" }, qty_sewer: { value: "0" }, qty_embroidery: { value: "0" }, qty_completed: { value: "0" } } };
    breakdown.push(row);
  }
  const current = parseInt(row.value[field].value);
  row.value[field] = { value: current + delta };
  row.value.qty_total = { value: parseInt(row.value.qty_total.value) + delta };
  return breakdown;
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
              if (!transformedMetaData[currentEmbroideryGroup]) {
                transformedMetaData[currentEmbroideryGroup] = {};
              }
              transformedMetaData[currentEmbroideryGroup]["Position"] = meta.value;
            } else if (
              meta.displayKey === "Line 1" ||
              meta.displayKey === "Line 1 Text Font" ||
              meta.displayKey === "Line 2" ||
              meta.displayKey === "Line 2 Text Font"
            ) {
              if (currentEmbroideryGroup) {
                transformedMetaData[currentEmbroideryGroup][meta.displayKey] = meta.value;
              } else {
                transformedMetaData[meta.displayKey] = meta.value;
              }
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

      const inventoryRes = await kintoneRequest('GET', `/v1/record.json?app=${INVENTORY_APP_ID}&query=bag_model="${bagModel}"`);
      const inventory = inventoryRes.data.record;
      const inventoryId = inventory.$id.value;

      const stockLevels = {
        'qty_warehouse': parseInt(inventory.qty_warehouse.value)
      };

      if (stockLevels.qty_warehouse < qty) {
        throw new Error(`Insufficient stock for ${bagModel} in warehouse`);
      }

      const update = {
        qty_warehouse: { value: stockLevels.qty_warehouse - qty },
        inventory_breakdown: { value: updateBreakdown(inventory, 'Ordered', 'qty_warehouse', qty) }
      };

      await kintoneRequest('PUT', `/v1/record.json`, {
        app: INVENTORY_APP_ID,
        id: inventoryId,
        record: update
      });
    }

    const processRecords = transformToProcessRecords(record, customer, 'Office');
    await kintoneRequest('POST', `/v1/records.json?app=${PROCESS_APP_ID}`, {
      records: processRecords
    });

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
    const previousStatus = record.Previous_Status?.value;
    if (!previousStatus || previousStatus === currentStatus) return res.sendStatus(200);

    const inventoryRes = await kintoneRequest('GET', `/v1/record.json?app=${INVENTORY_APP_ID}&query=bag_model="${bagModel}"`);
    const inventory = inventoryRes.data.record;
    const inventoryId = inventory.$id.value;

    const statusMap = {
      'Office': null, // No stock impact until assigned
      'Warehouse': 'qty_warehouse',
      'Sewing': 'qty_sewer',
      'Embroidery': 'qty_embroidery',
      'Completed': 'qty_completed'
    };

    const update = {};
    const updatedBreakdown = inventory.inventory_breakdown.value.slice();

    if (statusMap[previousStatus]) {
      update[statusMap[previousStatus]] = { value: parseInt(inventory[statusMap[previousStatus]].value) - 1 };
      updateBreakdown(inventory, 'Ordered', statusMap[previousStatus], -1);
    }
    if (statusMap[currentStatus]) {
      update[statusMap[currentStatus]] = { value: parseInt(inventory[statusMap[currentStatus]].value) + 1 };
      updateBreakdown(inventory, 'Ordered', statusMap[currentStatus], 1);
    }

    update.inventory_breakdown = { value: updatedBreakdown };

    await kintoneRequest('PUT', `/v1/record.json`, {
      app: INVENTORY_APP_ID,
      id: inventoryId,
      record: update
    });

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

module.exports = makeRouter;