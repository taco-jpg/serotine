package app.serotine.client;

import java.net.URI;
import java.util.Set;
import java.util.Map;
import java.util.Locale;

/** Pure Java validation, also exercised without an Android emulator. */
public final class NativePolicy {
    public static final int SNAPSHOT_LIMIT = 64 * 1024 * 1024;
    public static final int REQUEST_LIMIT = 8 * 1024 * 1024;
    public static final int RESPONSE_LIMIT = 16 * 1024 * 1024;
    public static final Map<String, Set<String>> ROUTES = Map.of(
        "/api/relay", Set.of("POST"), "/api/groups", Set.of("POST"),
        "/api/files", Set.of("GET", "POST", "PUT"), "/api/calls", Set.of("POST"),
        "/api/direct", Set.of("POST"), "/api/retention", Set.of("POST"),
        "/api/plugins/summary", Set.of("POST"), "/api/giphy/config", Set.of("GET")
    );
    public static String relayOrigin(String value) {
        URI uri = URI.create(value);
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null || uri.getRawUserInfo() != null
            || uri.getRawQuery() != null || uri.getRawFragment() != null || (uri.getPort() != -1 && uri.getPort() != 443)
            || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())) || host.equals("localhost")
            || !host.contains(".") || host.matches("[0-9.]+") || host.endsWith(".local")) throw new IllegalArgumentException("Invalid relay origin");
        return "https://" + host.toLowerCase(Locale.ROOT);
    }
    public static void request(String path, String method) {
        if (!ROUTES.containsKey(path) || !ROUTES.get(path).contains(method)) throw new IllegalArgumentException("Unsupported relay request");
    }
    public static void header(String name, String value) {
        if (!Set.of("content-type", "accept", "x-serotine-events", "x-serotine-file-request").contains(name.toLowerCase(Locale.ROOT))
            || value == null || value.length() > 32768 || value.chars().anyMatch(c -> c < 32 || c > 126)) throw new IllegalArgumentException("Unsupported relay header");
    }
    public static String filename(String value) {
        if (value == null || value.isBlank() || value.length() > 180 || value.equals(".") || value.equals("..")
            || value.chars().anyMatch(c -> c < 32 || c == '/' || c == '\\' || c == ':')) throw new IllegalArgumentException("Invalid file name");
        return value;
    }
    public static void encodedSize(String value, int limit) {
        if (value == null || value.length() % 4 != 0 || value.length() > 4L * ((limit + 2L) / 3L)) throw new IllegalArgumentException("Invalid or oversized file");
        int end = value.length();
        if (end > 0 && value.charAt(end - 1) == '=') end--;
        if (end > 0 && value.charAt(end - 1) == '=') end--;
        for (int i = 0; i < end; i++) {
            char c = value.charAt(i);
            if (!(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/')) throw new IllegalArgumentException("Invalid encoding");
        }
    }
}
