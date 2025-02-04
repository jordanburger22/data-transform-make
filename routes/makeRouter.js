const express = require('express');
const makeRouter = express.Router();

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

      // Use item.metaData (note the lowercase) if it exists.
      if (Array.isArray(item.metaData)) {
        item.metaData.forEach(meta => {
          // Only process entries with a string value (ignore if the value is an array)
          if (meta.value && typeof meta.value === 'string' && !meta.valueArray) {
            if (meta.displayKey && meta.displayKey.endsWith("Embroidery Position")) {
              // Derive a group name by removing " Position" from the displayKey.
              const groupName = meta.displayKey.replace(" Position", "");
              currentEmbroideryGroup = groupName;
              // Initialize the group if it doesn't exist.
              if (!transformedMetaData[currentEmbroideryGroup]) {
                transformedMetaData[currentEmbroideryGroup] = {};
              }
              // Save the embroidery position value.
              transformedMetaData[currentEmbroideryGroup]["Position"] = meta.value;
            } else if (
              meta.displayKey === "Line 1" ||
              meta.displayKey === "Line 1 Text Font" ||
              meta.displayKey === "Line 2" ||
              meta.displayKey === "Line 2 Text Font"
            ) {
              // If an embroidery group is active, store these keys inside that group.
              if (currentEmbroideryGroup) {
                transformedMetaData[currentEmbroideryGroup][meta.displayKey] = meta.value;
              } else {
                // Otherwise, store it at the top level.
                transformedMetaData[meta.displayKey] = meta.value;
              }
            } else {
              // For any other meta data, store it at the top level.
              transformedMetaData[meta.displayKey] = meta.value;
            }
          }
        });
      }

      // Combine the line item information with the transformed meta data.
      return {
        ID: item.id,           // using lowercase property names from the payload
        Name: item.name,
        Quantity: item.quantity,
        Subtotal: item.subtotal,
        Total: item.total,
        Taxes: item.taxes,     // taxes is an empty array in your example
        MetaData: transformedMetaData
      };
    });

    // Build the final JSON object for the entire order.
    const finalOrderObject = {
      order: transformedLineItems
    };

    // Send the transformed order object as a JSON response.
    return res.status(200).json(finalOrderObject);
  } catch (error) {
    // Pass any errors to the error-handling middleware.
    next(error);
  }
});

module.exports = makeRouter;
