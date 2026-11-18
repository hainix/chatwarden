// The demo: the whole conversation of examples/service/curl.sh against a running service, through ChatwardenClient. Every step is checked against the
// strings in examples/service/expectations.json, the file conformance.mjs reads too, and the program exits 1 on any surprise.
//   BASE=http://127.0.0.1:8787 KEY=<a service key> dotnet run --project examples/service-csharp
using System.Text.Json;
using Chatwarden.Sample;

var baseUrl = Environment.GetEnvironmentVariable("BASE") ?? "http://127.0.0.1:8787";
var key = Environment.GetEnvironmentVariable("KEY");
if (string.IsNullOrEmpty(key))
{
    Console.Error.WriteLine("KEY is not set: pass a service key in the KEY variable.");
    return 1;
}

var candidates = new[] { Environment.GetEnvironmentVariable("EXPECTATIONS"), "examples/service/expectations.json", "../service/expectations.json" };
var file = candidates.FirstOrDefault(p => !string.IsNullOrEmpty(p) && File.Exists(p));
if (file is null)
{
    Console.Error.WriteLine("expectations.json was not found: run from the repository root, or set EXPECTATIONS to its path.");
    return 1;
}
var expectations = JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("steps").EnumerateArray()
    .ToDictionary(s => s.GetProperty("name").GetString()!, s => s);

var failures = new List<string>();
var unauthorized = false;

// One step: the call has been made; its answer is checked against expectations.json.
void Step(string name, Reply reply)
{
    if (reply.Status == 401)
    {
        unauthorized = true;
        return;
    }
    var want = expectations[name];
    var problems = new List<string>();
    if (reply.Status != 200) problems.Add($"status {reply.Status}, wanted 200");
    foreach (var text in want.GetProperty("expect").EnumerateArray())
        if (!reply.Body.Contains(text.GetString()!, StringComparison.Ordinal)) problems.Add($"the answer lacks {text.GetString()}");
    if (want.TryGetProperty("headers", out var headers))
        foreach (var header in headers.EnumerateArray())
            if (reply.Headers is null || !reply.Headers.Contains(header.GetString()!)) problems.Add($"the answer has no {header.GetString()} header");
    if (problems.Count > 0)
    {
        failures.Add(name);
        Console.Error.WriteLine($"FAILED {name}: {string.Join("; ", problems)}");
    }
    else Console.WriteLine($"ok  {name}");
}

try
{
    using var client = new ChatwardenClient(baseUrl, key);
    var run = Guid.NewGuid().ToString("N")[..8];
    var room = $"cs-{run}";
    var alice = new { clientKey = $"conformance-alice-{run}" };
    var bob = new { clientKey = $"conformance-bob-{run}" };

    Step("handshake", await client.Handshake());
    Step("seat alice", await client.Seat(room, "alice", alice, "alice"));
    Step("seat bob", await client.Seat(room, "bob", bob, "bob"));
    var clean = await client.CheckLine(room, "alice", "good luck, have fun");
    Step("clean line", clean);
    var lineId = clean.Ok ? clean.Json().RootElement.GetProperty("line").GetProperty("id").GetString() : null;
    // The retry carries the key of the first attempt, so the service answers it from what it stored (the idempotent-replay header) instead of judging the line again.
    var slurKey = Guid.NewGuid().ToString("N");
    Step("slur refused", await client.CheckLine(room, "alice", "you zorbak", slurKey));
    Step("slur retried", await client.CheckLine(room, "alice", "you zorbak", slurKey));
    Step("report", await client.Report(room, "bob", "alice", lineId, "harassment"));
    Step("pending notices", await client.PendingNotices(alice));
    Step("ack unknown notice", await client.Ack("not-a-notice", alice));
    Step("record", await client.Record(alice));
    Step("restriction", await client.Restriction(alice));
    Step("doors check", await client.DoorsCheck("join", alice));
    Step("name check", await client.NamesCheck("Plenk the Brave"));
    Step("name refused", await client.NamesCheck("Mr zorbak"));
    Step("mute", await client.Mute(room, "bob", "alice"));
    Step("mutes list", await client.Mutes(room, "bob"));
    Step("unseat", await client.Unseat(room, "alice"));
    Step("close room", await client.CloseRoom(room));
}
catch (HttpRequestException)
{
    Console.Error.WriteLine($"could not reach {baseUrl}: is the service running?");
    return 1;
}

if (unauthorized)
{
    Console.Error.WriteLine("unauthorized: the service refused the key.");
    return 1;
}
if (failures.Count > 0)
{
    Console.Error.WriteLine($"{failures.Count} step(s) failed: {string.Join(", ", failures)}");
    return 1;
}
Console.WriteLine($"all {expectations.Count} steps passed");
return 0;
