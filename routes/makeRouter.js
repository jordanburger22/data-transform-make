const express = require('express');
const makeRouter = express.Router();

makeRouter.post('/process-order', (req, res) => {
  // Extract the "Line Items" array from the request body.
  console.log(req.body)
  const lineItems = req.body["Line Items"];

  if (!Array.isArray(lineItems)) {
    return res.status(400).json({ error: 'Invalid data: expected "Line Items" to be an array' });
  }

  // Process each line item.
  const transformedLineItems = lineItems.map(item => {
    let transformedMetaData = {};
    let currentEmbroideryGroup = null; // To keep track of the current embroidery context

    // Check if the item has a "Meta Data" array.
    if (Array.isArray(item["Meta Data"])) {
      // Process meta data items in order
      item["Meta Data"].forEach(meta => {
        // Only process entries with a string Value (ignore those with ValueArray)
        if (meta.Value && typeof meta.Value === 'string' && !meta.ValueArray) {
          // Check if this is an embroidery position marker.
          // For example, if the displayKey is "Front Embroidery Position" or "Lid Embroidery Position"
          if (meta.displayKey.endsWith("Embroidery Position")) {
            // Derive a group name by removing " Position" from the displayKey.
            const groupName = meta.displayKey.replace(" Position", "");
            currentEmbroideryGroup = groupName;
            // Initialize the group if it does not exist
            if (!transformedMetaData[currentEmbroideryGroup]) {
              transformedMetaData[currentEmbroideryGroup] = {};
            }
            // Save the embroidery position value (optional—you might label it as "Position")
            transformedMetaData[currentEmbroideryGroup]["Position"] = meta.Value;
          } else if (
            meta.displayKey === "Line 1" ||
            meta.displayKey === "Line 1 Text Font" ||
            meta.displayKey === "Line 2" ||
            meta.displayKey === "Line 2 Text Font"
          ) {
            // For line data, if an embroidery group is active, add the data there.
            if (currentEmbroideryGroup) {
              // If the key already exists and you wish to support multiple entries, you can store an array.
              // For now, we simply overwrite with the latest value.
              transformedMetaData[currentEmbroideryGroup][meta.displayKey] = meta.Value;
            } else {
              // If no embroidery context is active, store it at the top level.
              transformedMetaData[meta.displayKey] = meta.Value;
            }
          } else {
            // For any other meta data, store it at the top level.
            transformedMetaData[meta.displayKey] = meta.Value;
          }
        }
      });
    }

    // Combine the line item information with the transformed meta data.
    return {
      ID: item.ID,
      Name: item.Name,
      Quantity: item.Quantity,
      Subtotal: item.Subtotal,
      Total: item.Total,
      Taxes: item.Taxes, // Process as needed.
      MetaData: transformedMetaData
    };
  });

  // Build a final JSON object for the entire order.
  const finalOrderObject = {
    order: transformedLineItems
  };

  // Send the transformed order object as a JSON response.
  return res.status(200).send(finalOrderObject)
});

module.exports = makeRouter;
