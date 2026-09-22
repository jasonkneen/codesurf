const std = @import("std");
const builtin = @import("builtin");

/// The Native package entry point is a real executable rather than a shell
/// script so macOS can sign and verify the entire .app bundle strictly. It
/// starts the Node supervisor, which owns both loopback services and the real
/// Native WebView executable, then mirrors the supervisor's exit status.
const BundlePaths = struct {
    resources_dir: []const u8,
    native_binary: []const u8,
    packaged_node: []const u8,
    supervisor: []const u8,
    app_root: []const u8,

    fn deinit(self: BundlePaths, allocator: std.mem.Allocator) void {
        allocator.free(self.resources_dir);
        allocator.free(self.native_binary);
        allocator.free(self.packaged_node);
        allocator.free(self.supervisor);
        allocator.free(self.app_root);
    }
};

fn bundlePaths(allocator: std.mem.Allocator, executable_dir: []const u8, is_macos: bool) !BundlePaths {
    const resources_dir = try std.fs.path.resolve(allocator, &.{
        executable_dir,
        if (is_macos) "../Resources" else "../resources",
    });
    errdefer allocator.free(resources_dir);

    const native_binary = try std.fs.path.join(allocator, &.{ executable_dir, "codesurf-native" });
    errdefer allocator.free(native_binary);
    const packaged_node = try std.fs.path.join(allocator, &.{
        resources_dir,
        "sidecar",
        "bin",
        if (builtin.os.tag == .windows) "node.exe" else "node",
    });
    errdefer allocator.free(packaged_node);
    const supervisor = try std.fs.path.join(allocator, &.{ resources_dir, "sidecar", "supervisor.mjs" });
    errdefer allocator.free(supervisor);
    const app_root = try std.fs.path.join(allocator, &.{ resources_dir, "sidecar", "app" });

    return .{
        .resources_dir = resources_dir,
        .native_binary = native_binary,
        .packaged_node = packaged_node,
        .supervisor = supervisor,
        .app_root = app_root,
    };
}

fn allowsSystemNode(env_map: *const std.process.Environ.Map) bool {
    const value = env_map.get("CODESURF_DESKTOP_ALLOW_SYSTEM_NODE") orelse return false;
    return std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true");
}

fn isExecutable(io: std.Io, absolute_path: []const u8) bool {
    std.Io.Dir.accessAbsolute(io, absolute_path, .{ .execute = true }) catch return false;
    return true;
}

fn runtimeForLaunch(init: std.process.Init, paths: BundlePaths) ![]const u8 {
    if (isExecutable(init.io, paths.packaged_node)) return paths.packaged_node;
    if (allowsSystemNode(init.environ_map)) {
        return init.environ_map.get("CODESURF_DESKTOP_NODE_RUNTIME") orelse "node";
    }

    std.debug.print(
        "CodeSurf Native sidecar runtime is missing or not executable: {s}\n" ++
            "Reinstall the app, or set CODESURF_DESKTOP_ALLOW_SYSTEM_NODE=1 for an explicit development fallback.\n",
        .{paths.packaged_node},
    );
    return error.MissingPackagedNodeRuntime;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const executable_dir = try std.process.executableDirPathAlloc(init.io, allocator);
    const paths = try bundlePaths(allocator, executable_dir, builtin.os.tag == .macos);
    const node_runtime = try runtimeForLaunch(init, paths);

    var env = std.process.Environ.Map.init(allocator);
    const keys = init.environ_map.keys();
    const values = init.environ_map.values();
    for (keys, values) |key, value| try env.put(key, value);
    try env.put("CODESURF_SIDECAR_APP_ROOT", paths.app_root);

    const received_args = try init.minimal.args.toSlice(allocator);
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(allocator, &.{ node_runtime, paths.supervisor, "--native-binary", paths.native_binary });
    if (received_args.len > 1) {
        try argv.append(allocator, "--");
        for (received_args[1..]) |arg| try argv.append(allocator, arg);
    }

    var child = try std.process.spawn(init.io, .{
        .argv = argv.items,
        .stdin = .inherit,
        .stdout = .inherit,
        .stderr = .inherit,
        .environ_map = &env,
    });
    const term = try child.wait(init.io);
    switch (term) {
        .exited => |code| std.process.exit(code),
        // A signal means the supervisor could not report a normal process
        // status. The supervisor itself handles SIGINT/SIGTERM and cleans up
        // its children before normally exiting with the corresponding code.
        else => std.process.exit(1),
    }
}

test "bundle paths resolve macOS resources beside the executable" {
    const allocator = std.testing.allocator;
    const paths = try bundlePaths(allocator, "/Applications/CodeSurf.app/Contents/MacOS", true);
    defer paths.deinit(allocator);

    try std.testing.expectEqualStrings("/Applications/CodeSurf.app/Contents/Resources", paths.resources_dir);
    try std.testing.expectEqualStrings("/Applications/CodeSurf.app/Contents/MacOS/codesurf-native", paths.native_binary);
    try std.testing.expectEqualStrings("/Applications/CodeSurf.app/Contents/Resources/sidecar/supervisor.mjs", paths.supervisor);
}

test "system Node fallback requires an explicit opt-in" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try std.testing.expect(!allowsSystemNode(&env));
    try env.put("CODESURF_DESKTOP_ALLOW_SYSTEM_NODE", "true");
    try std.testing.expect(allowsSystemNode(&env));
}
