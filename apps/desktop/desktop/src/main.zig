const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const json = @import("json");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// Production assets are copied from the root Vite build into `desktop/frontend`
/// before validation/package. A Native manifest cannot legally escape its app
/// directory with `..`, and packaged assets land at Resources/frontend.
const frontend_dist = "frontend";

const runtime_config_command = "codesurf.runtime.getConfig";
const runtime_config_origins = [_][]const u8{
    "zero://app",
    // `native dev` serves the same renderer from Vite before it is packaged
    // at zero://app. Keep this list exactly aligned with allowed_origins.
    "http://127.0.0.1:5173",
    "http://localhost:5173",
};
const runtime_config_policies = [_]native_sdk.BridgeCommandPolicy{
    .{ .name = runtime_config_command, .origins = &runtime_config_origins },
};

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    bridge_handlers: [1]native_sdk.BridgeHandler = undefined,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "codesurf",
            .source = native_sdk.frontend.productionSource(.{ .dist = frontend_dist }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = frontend_dist,
            .entry = "index.html",
        });
    }

    /// The renderer obtains the short-lived loopback credentials from the
    /// Native bridge, never from an unauthenticated HTTP config endpoint. The
    /// sidecar supervisor owns and atomically writes this 0600 JSON file.
    fn bridge(self: *@This()) native_sdk.BridgeDispatcher {
        self.bridge_handlers = .{.{
            .name = runtime_config_command,
            .context = self,
            .invoke_fn = getRuntimeConfig,
        }};
        return .{
            .policy = .{ .enabled = true, .commands = &runtime_config_policies },
            .registry = .{ .handlers = &self.bridge_handlers },
        };
    }

    fn getRuntimeConfig(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation; // The caller never selects a path or any config field.
        const self: *@This() = @ptrCast(@alignCast(context));
        const path = self.env_map.get("CODESURF_RUNTIME_CONFIG_PATH") orelse return "{}";

        var file = std.Io.Dir.cwd().openFile(self.io, path, .{}) catch return "{}";
        defer file.close(self.io);

        var config_bytes: [8 * 1024]u8 = undefined;
        const len = file.readPositionalAll(self.io, &config_bytes, 0) catch return "{}";
        return sanitizeRuntimeConfig(config_bytes[0..len], output) catch "{}";
    }
};

/// Returns only the exact renderer-facing contract. Host and terminal URLs
/// must remain loopback URLs; malformed/missing fields are omitted rather than
/// reflected into the WebView. Tokens are never logged.
fn sanitizeRuntimeConfig(config: []const u8, output: []u8) ![]const u8 {
    var host_base_storage: [2048]u8 = undefined;
    var host_token_storage: [2048]u8 = undefined;
    var terminal_endpoint_storage: [2048]u8 = undefined;
    var terminal_token_storage: [2048]u8 = undefined;

    var host_base_strings = json.StringStorage.init(&host_base_storage);
    var host_token_strings = json.StringStorage.init(&host_token_storage);
    var terminal_endpoint_strings = json.StringStorage.init(&terminal_endpoint_storage);
    var terminal_token_strings = json.StringStorage.init(&terminal_token_storage);

    const host_base = json.stringField(config, "hostBase", &host_base_strings);
    const host_token = json.stringField(config, "hostToken", &host_token_strings);
    const terminal_config = json.fieldValue(config, "terminal");
    const terminal_endpoint = if (terminal_config) |value|
        json.stringField(value, "endpoint", &terminal_endpoint_strings)
    else
        null;
    const terminal_token = if (terminal_config) |value|
        json.stringField(value, "token", &terminal_token_strings)
    else
        null;

    var writer = std.Io.Writer.fixed(output);
    try writer.writeByte('{');
    var wrote_field = false;
    if (host_base) |value| {
        if (isLoopbackHttpUrl(value)) {
            try writeJsonField(&writer, &wrote_field, "hostBase", value);
        }
    }
    if (host_token) |value| {
        if (isValidSecret(value)) {
            try writeJsonField(&writer, &wrote_field, "hostToken", value);
        }
    }

    const valid_terminal_endpoint = if (terminal_endpoint) |value| isLoopbackTerminalUrl(value) else false;
    const valid_terminal_token = if (terminal_token) |value| isValidSecret(value) else false;
    if (valid_terminal_endpoint or valid_terminal_token) {
        if (wrote_field) try writer.writeByte(',');
        try writer.writeAll("\"terminal\":{");
        var wrote_terminal_field = false;
        if (valid_terminal_endpoint) {
            try writeJsonField(&writer, &wrote_terminal_field, "endpoint", terminal_endpoint.?);
        }
        if (valid_terminal_token) {
            try writeJsonField(&writer, &wrote_terminal_field, "token", terminal_token.?);
        }
        try writer.writeByte('}');
    }
    try writer.writeByte('}');
    return writer.buffered();
}

fn writeJsonField(writer: anytype, wrote_field: *bool, name: []const u8, value: []const u8) !void {
    if (wrote_field.*) try writer.writeByte(',');
    try json.writeString(writer, name);
    try writer.writeByte(':');
    try json.writeString(writer, value);
    wrote_field.* = true;
}

fn isLoopbackHttpUrl(value: []const u8) bool {
    return std.mem.startsWith(u8, value, "http://127.0.0.1:") and isSafeUrl(value);
}

fn isLoopbackTerminalUrl(value: []const u8) bool {
    return (std.mem.startsWith(u8, value, "http://127.0.0.1:") or
        std.mem.startsWith(u8, value, "ws://127.0.0.1:")) and isSafeUrl(value);
}

fn isSafeUrl(value: []const u8) bool {
    if (value.len == 0 or value.len > 1024) return false;
    for (value) |ch| {
        if (ch <= 0x20 or ch == 0x7f) return false;
    }
    return true;
}

fn isValidSecret(value: []const u8) bool {
    if (value.len == 0 or value.len > 1024) return false;
    for (value) |ch| {
        if (ch <= 0x20 or ch == 0x7f) return false;
    }
    return true;
}

// Dev Vite origin + production asset origins. Daemon/web-host XHR is not navigation.
const allowed_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
};

const app_permissions = [_][]const u8{
    native_sdk.security.permission_dialog,
    native_sdk.security.permission_network,
};

const dialog_permission = [_][]const u8{native_sdk.security.permission_dialog};
const network_permission = [_][]const u8{native_sdk.security.permission_network};

const builtin_policies = [_]native_sdk.BridgeCommandPolicy{
    .{ .name = "native-sdk.dialog.openFile", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.dialog.saveFile", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.dialog.showMessage", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.os.openUrl", .permissions = &network_permission, .origins = &allowed_origins },
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map, .io = init.io };
    try runner.runWithOptions(app.app(), .{
        .app_name = "codesurf",
        .window_title = "CodeSurf",
        .bundle_id = "inc.codesurf.app",
        .icon_path = "assets/icon.png",
        .js_window_api = true,
        .bridge = app.bridge(),
        .builtin_bridge = .{ .enabled = true, .commands = &builtin_policies },
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{
                .allowed_origins = &allowed_origins,
                .external_links = .{ .action = .open_system_browser },
            },
        },
    }, init);
}

test "production source points at staged Native frontend" {
    const source = native_sdk.frontend.productionSource(.{ .dist = frontend_dist });
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings(frontend_dist, source.asset_options.?.root_path);
}

test "runtime bridge exposes only valid loopback fields" {
    var output: [4096]u8 = undefined;
    const result = try sanitizeRuntimeConfig(
        "{\"hostBase\":\"http://127.0.0.1:41234\",\"hostToken\":\"host-secret\",\"terminal\":{\"endpoint\":\"ws://127.0.0.1:45678\",\"token\":\"terminal-secret\"},\"ignored\":\"never-return\"}",
        &output,
    );
    try std.testing.expectEqualStrings(
        "{\"hostBase\":\"http://127.0.0.1:41234\",\"hostToken\":\"host-secret\",\"terminal\":{\"endpoint\":\"ws://127.0.0.1:45678\",\"token\":\"terminal-secret\"}}",
        result,
    );
}

test "runtime bridge omits non-loopback URLs and invalid secrets" {
    var output: [4096]u8 = undefined;
    const result = try sanitizeRuntimeConfig(
        "{\"hostBase\":\"https://proxy.example\",\"hostToken\":\"bad token\",\"terminal\":{\"endpoint\":\"ws://example.test:9999\",\"token\":\"\"}}",
        &output,
    );
    try std.testing.expectEqualStrings("{}", result);
}
