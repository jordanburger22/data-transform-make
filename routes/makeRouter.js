const express = require('express');
const makeRouter = express.Router();

/**
 * Combines embroidery group information from the metaData object into a single multi‐line string.
 * For each embroidery group (determined by the presence of a "Position" property),
 * the function formats all the key/value pairs in that group, skipping any where the value is "No".
 */
function combineEmbroideryInfo(metaData) {
    let combined = '';
    for (const key in metaData) {
        const group = metaData[key];
        // If this group appears to be an embroidery group (has a "Position" property)
        if (group && typeof group === 'object' && group.Position) {
            let groupText = `${key}:\n`;
            for (const subKey in group) {
                if (group[subKey] === "No") continue; // Skip if the value is "No"
                groupText += `  ${subKey}: ${group[subKey]}\n`;
            }
            if (groupText.trim()) {
                combined += groupText + "\n";
            }
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
            bag_lookup_website: `${item.productId} - ${item.MetaData["Color Selection"] || ""}`,
            bag_model_website: item.Name, // Use the Name from Make as the bag model.
            bag_color_website: item.MetaData["Color Selection"] || "",
            qty_website: String(item.Quantity),
            rate_website: item.Subtotal,
            total_website: item.Total,
            rigid_lightened_website: item.MetaData["Rigid or Lightened Selection"] || "",
            divider_website: item.MetaData["Divider Option Selection"] || "",
            wheel_option_website: item.MetaData["Wheel Type"] || "",
            logo_website: item.MetaData["Company Logo"] || "",
            order_details_website: embroideryInfo,
            // Use the value from the "Additional Notes" key in meta data.
            notes_website: item.MetaData["Additional Notes"] || ""
        };
    });
}

makeRouter.post('/process-order', (req, res, next) => {
    try {
        // The request body is expected to be an array of line items.
        const lineItems = req.body;
        if (!Array.isArray(lineItems)) {
            throw new Error('Invalid data: expected request body to be an array of line items');
        }

        // Process each line item.
        const transformedLineItems = lineItems.map(item => {
            let transformedMetaData = {};
            let currentEmbroideryGroup = null; // To track the active embroidery context

            // Process the meta data (key is "metaData" in the payload).
            if (Array.isArray(item.metaData)) {
                item.metaData.forEach(meta => {
                    // Only process entries with a string value (ignore if the value is an array)
                    if (meta.value && typeof meta.value === 'string' && !meta.valueArray) {
                        if (meta.displayKey && meta.displayKey.endsWith("Embroidery Position")) {
                            // Derive a group name by removing " Position" from the displayKey.
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
                productId: item.productId, // Needed for bag lookup
                Quantity: item.quantity,
                Subtotal: item.subtotal,
                Total: item.total,
                Taxes: item.taxes, // Expected to be an empty array in your example
                MetaData: transformedMetaData
            };
        });

        // Build the final order object.
        const finalOrderObject = { order: transformedLineItems };

        // Transform the final order object into an array of simplified Kintone records.
        const simpleRecords = transformToSimpleRecords(finalOrderObject);

        // Send the array of simplified records as the JSON response.
        return res.status(200).json(simpleRecords);
    } catch (error) {
        next(error);
    }
});

module.exports = makeRouter;
