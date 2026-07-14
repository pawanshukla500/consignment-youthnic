const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

// Download consignment template
router.get('/consignment', authenticateToken, requirePermission('consignments', 'download templates'), (req, res) => {
  const csvContent = `marketplaceBarcode,marketplaceBarcodeType,marketplaceSku,internalSku,requiredQty
"X00ABC123","FNSKU","B08N5WRWNW","TSHIRT-BLK-M",10
"X00ABC124","FNSKU","B08N5M7S6K","TSHIRT-WHT-L",5
"FSN123456","FSN","FK-SKU-1001","JEANS-BLU-32",8
"ASIN78910","ASIN","B08N5M7S62","HOODIE-GRY-M",12
"AJIOBAR998","Marketplace","AJIO-SKU-77","SHIRT-WHT-L",7
`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sku_template.csv"');
  res.send(csvContent);
});

module.exports = router;
