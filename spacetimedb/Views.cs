using SpacetimeDB;

public static partial class Module
{
    // Driver privacy: a driver only ever receives their own messages.
    [SpacetimeDB.View(Accessor = "MyMessages", Public = true, PrimaryKey = nameof(DriverMessage.Id))]
    public static List<DriverMessage> MyMessages(ViewContext ctx) =>
        ctx.Db.DriverMessage.ToDriver.Filter(ctx.Sender).ToList();

    // Supervisors see the full message log (ack status); everyone else gets [].
    [SpacetimeDB.View(Accessor = "SupervisorMessages", Public = true, PrimaryKey = nameof(DriverMessage.Id))]
    public static List<DriverMessage> SupervisorMessages(ViewContext ctx)
    {
        if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is not { Role: Role.Supervisor })
            return new();
        return ctx.Db.DriverMessage.SentAt
            .Filter((new Timestamp(0), new Timestamp(long.MaxValue)))
            .OrderByDescending(m => m.SentAt.MicrosecondsSinceUnixEpoch)
            .Take(50)
            .ToList();
    }

    // Audit trail: supervisors only, last 100 entries.
    [SpacetimeDB.View(Accessor = "AuditTrail", Public = true, PrimaryKey = nameof(AuditLog.Id))]
    public static List<AuditLog> AuditTrail(ViewContext ctx)
    {
        if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is not { Role: Role.Supervisor })
            return new();
        return ctx.Db.AuditLog.At
            .Filter((new Timestamp(0), new Timestamp(long.MaxValue)))
            .OrderByDescending(a => a.At.MicrosecondsSinceUnixEpoch)
            .Take(100)
            .ToList();
    }
}
