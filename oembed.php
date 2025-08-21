<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// Get URL parameter
$url = $_GET['url'] ?? '';
$format = $_GET['format'] ?? 'json';

if (empty($url)) {
    http_response_code(400);
    echo json_encode(['error' => 'URL parameter required']);
    exit;
}

// Extract bundle data from URL
$bundleName = 'MCP Bundle Preview';
$bundleDescription = 'Preview an MCP server bundle';

// Parse the URL to get bundle data
if (preg_match('/#\/(.+)$/', $url, $matches)) {
    $encodedData = $matches[1];
    
    try {
        // Convert URL-safe Base64 back to standard Base64
        $standardBase64 = strtr($encodedData, '-_', '+/');
        // Add padding if needed
        $paddedBase64 = $standardBase64 . str_repeat('=', (4 - strlen($standardBase64) % 4) % 4);
        
        // Try to decode as binary first (new format)
        $binaryString = base64_decode($paddedBase64);
        if ($binaryString !== false && strlen($binaryString) >= 5) {
            // Binary format: 1 byte name length + 4 bytes timestamp + name + server IDs
            $nameLength = ord($binaryString[0]);
            if (strlen($binaryString) >= 5 + $nameLength) {
                $bundleName = substr($binaryString, 5, $nameLength);
                if (!empty($bundleName)) {
                    $bundleName .= ' - MCP Bundle';
                    $serverCount = (strlen($binaryString) - 5 - $nameLength) / 4;
                    $bundleDescription = "MCP bundle with " . floor($serverCount) . " servers";
                }
            }
        } else {
            // Fall back to JSON format (old URLs)
            $decoded = base64_decode($encodedData);
            if ($decoded !== false) {
                $bundleData = json_decode($decoded, true);
                if (isset($bundleData['name'])) {
                    $bundleName = $bundleData['name'] . ' - MCP Bundle';
                    if (isset($bundleData['servers'])) {
                        $bundleDescription = "MCP bundle with " . count($bundleData['servers']) . " servers";
                    }
                }
            }
        }
    } catch (Exception $e) {
        // Keep default values if decoding fails
    }
}

// Generate oEmbed response
$response = [
    'version' => '1.0',
    'type' => 'rich',
    'width' => 600,
    'height' => 400,
    'title' => $bundleName,
    'author_name' => 'MCP Bundler',
    'author_url' => 'https://mcp-bundler.maketry.xyz',
    'provider_name' => 'MCP Bundler',
    'provider_url' => 'https://mcp-bundler.maketry.xyz',
    'html' => '<iframe src="' . htmlspecialchars($url) . '" width="600" height="400" frameborder="0"></iframe>'
];

if ($format === 'xml') {
    header('Content-Type: application/xml');
    echo '<?xml version="1.0" encoding="utf-8" standalone="yes"?>' . "\n";
    echo '<oembed>' . "\n";
    echo '    <version>' . htmlspecialchars($response['version']) . '</version>' . "\n";
    echo '    <type>' . htmlspecialchars($response['type']) . '</type>' . "\n";
    echo '    <width>' . htmlspecialchars($response['width']) . '</width>' . "\n";
    echo '    <height>' . htmlspecialchars($response['height']) . '</height>' . "\n";
    echo '    <title>' . htmlspecialchars($response['title']) . '</title>' . "\n";
    echo '    <author_name>' . htmlspecialchars($response['author_name']) . '</author_name>' . "\n";
    echo '    <author_url>' . htmlspecialchars($response['author_url']) . '</author_url>' . "\n";
    echo '    <provider_name>' . htmlspecialchars($response['provider_name']) . '</provider_name>' . "\n";
    echo '    <provider_url>' . htmlspecialchars($response['provider_url']) . '</provider_url>' . "\n";
    echo '    <html>' . htmlspecialchars($response['html']) . '</html>' . "\n";
    echo '</oembed>';
} else {
    echo json_encode($response, JSON_PRETTY_PRINT);
}
?>