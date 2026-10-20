using SpacetimeDB;

public static partial class Module
{
    const int MaxAuditRows = 500;
    const int MaxMessages = 200;
    const int MaxResolvedIncidents = 30;
    static readonly TimeDuration EscalationDelay = TimeDuration.FromSeconds(30);
    const string SupervisorCodeKey = "supervisor_code";
    const string SystemName = "Système";

    static readonly Timestamp MinTs = new(0);
    static readonly Timestamp MaxTs = new(long.MaxValue);

    // ---------------------------------------------------------------- Labels (French, for audit/alerts)

    static string RoleLabel(Role r) => r switch
    {
        Role.Supervisor => "Superviseur PCC",
        Role.Driver => "Chauffeur",
        _ => "Voyageur",
    };

    static string KindLabel(IncidentKind k) => k switch
    {
        IncidentKind.Breakdown => "Panne",
        IncidentKind.Accident => "Accident",
        IncidentKind.Assault => "Agression",
        IncidentKind.PassengerIllness => "Voyageur malaise",
        _ => "Retard",
    };

    static string SeverityLabel(IncidentSeverity s) => s switch
    {
        IncidentSeverity.Low => "Faible",
        IncidentSeverity.Medium => "Moyenne",
        IncidentSeverity.High => "Haute",
        _ => "Critique",
    };

    static IncidentSeverity DefaultSeverity(IncidentKind k) => k switch
    {
        IncidentKind.Accident or IncidentKind.Assault => IncidentSeverity.High,
        IncidentKind.Breakdown or IncidentKind.PassengerIllness => IncidentSeverity.Medium,
        _ => IncidentSeverity.Low,
    };

    static readonly string[] RandomDescriptions =
    {
        "Signalé automatiquement par la simulation.",
        "Voyant moteur allumé, véhicule à l'arrêt.",
        "Accrochage léger avec un véhicule privé.",
        "Altercation entre voyageurs à bord.",
        "Un voyageur a fait un malaise, secours demandés.",
        "Circulation dense, chantier sur l'itinéraire.",
        "Porte arrière bloquée.",
        "Obstacle sur la chaussée.",
    };

    // ---------------------------------------------------------------- Helpers

    static AppUser RequireRole(ReducerContext ctx, Role role)
    {
        if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is { } user && user.Role == role)
            return user;
        throw new Exception($"Accès refusé : rôle {RoleLabel(role)} requis.");
    }

    static void RequireScheduler(ReducerContext ctx)
    {
        if (ctx.Sender != ctx.DatabaseIdentity)
            throw new Exception("Réservé au planificateur.");
    }

    static string CleanText(string? s, int min, int max, string field)
    {
        var t = (s ?? "").Trim();
        if (t.Length < min || t.Length > max)
            throw new Exception(min > 0
                ? $"{field} : entre {min} et {max} caractères."
                : $"{field} : {max} caractères au maximum.");
        return t;
    }

    static void Audit(ReducerContext ctx, string actorName, string action, string details)
    {
        ctx.Db.AuditLog.Insert(new AuditLog
        {
            Id = 0,
            At = ctx.Timestamp,
            Actor = ctx.Sender,
            ActorName = actorName,
            Action = action,
            Details = details,
        });
        var excess = (int)ctx.Db.AuditLog.Count - MaxAuditRows;
        if (excess > 0)
        {
            var oldest = ctx.Db.AuditLog.At.Filter((MinTs, MaxTs))
                .OrderBy(a => a.At.MicrosecondsSinceUnixEpoch).ThenBy(a => a.Id)
                .Take(excess).ToList();
            foreach (var a in oldest)
                ctx.Db.AuditLog.Id.Delete(a.Id);
        }
    }

    static void Alert(ReducerContext ctx, string kind, string title, string body, IncidentSeverity sev, uint lineId)
    {
        ctx.Db.AlertEvent.Insert(new AlertEvent
        {
            Kind = kind,
            Title = title,
            Body = body,
            Severity = sev,
            LineId = lineId,
            At = ctx.Timestamp,
        });
    }

    static Vehicle RequireVehicle(ReducerContext ctx, uint vehicleId) =>
        ctx.Db.Vehicle.Id.Find(vehicleId) ?? throw new Exception("Véhicule inconnu.");

    static string LineCode(ReducerContext ctx, uint lineId) =>
        ctx.Db.Line.Id.Find(lineId) is { } l ? l.Code : lineId.ToString();

    static string StopName(ReducerContext ctx, uint stopId) =>
        ctx.Db.Stop.Id.Find(stopId) is { } s ? s.Name : "?";

    static void DeleteEscalations(ReducerContext ctx, ulong incidentId)
    {
        foreach (var e in ctx.Db.IncidentEscalation.IncidentId.Filter(incidentId).ToList())
            ctx.Db.IncidentEscalation.ScheduledId.Delete(e.ScheduledId);
    }

    static void ScheduleEscalation(ReducerContext ctx, ulong incidentId)
    {
        ctx.Db.IncidentEscalation.Insert(new IncidentEscalation
        {
            ScheduledId = 0,
            ScheduledAt = new ScheduleAt.Time(ctx.Timestamp + EscalationDelay),
            IncidentId = incidentId,
        });
    }

    /// Shared by ReportIncident (driver) and InjectRandomIncident (supervisor demo control).
    static Incident CreateIncident(ReducerContext ctx, Vehicle vehicle, IncidentKind kind, string description, string reporterName)
    {
        var pos = ctx.Db.VehiclePosition.VehicleId.Find(vehicle.Id);
        var incident = ctx.Db.Incident.Insert(new Incident
        {
            Id = 0,
            Kind = kind,
            Severity = DefaultSeverity(kind),
            Status = IncidentStatus.Open,
            LineId = vehicle.LineId,
            VehicleId = vehicle.Id,
            Lat = pos?.Lat ?? 0,
            Lon = pos?.Lon ?? 0,
            Description = description,
            ReportedBy = ctx.Sender,
            ReporterName = reporterName,
            ReportedAt = ctx.Timestamp,
            AssignedTo = null,
            AssigneeName = "",
            Escalations = 0,
            UpdatedAt = ctx.Timestamp,
            ResolvedAt = null,
        });
        ScheduleEscalation(ctx, incident.Id);
        var stop = pos is { } p ? StopName(ctx, p.NextStopId) : "?";
        Alert(ctx, "incident", $"Nouvel incident : {KindLabel(kind)}",
            $"{vehicle.Label} – Ligne {LineCode(ctx, vehicle.LineId)} – {stop}",
            incident.Severity, vehicle.LineId);
        return incident;
    }

    // ---------------------------------------------------------------- Lifecycle

    [SpacetimeDB.Reducer(ReducerKind.Init)]
    public static void Init(ReducerContext ctx)
    {
        SeedNetwork(ctx);
        SeedVehicles(ctx);
        ctx.Db.SimConfig.Insert(new SimConfig { Id = 0, SpeedFactor = 1, Paused = false, TickCount = 0, LastTickAt = ctx.Timestamp });
        ctx.Db.SimTick.Insert(new SimTick { ScheduledId = 0, ScheduledAt = new ScheduleAt.Interval(TimeSpan.FromSeconds(1)) });
        ctx.Db.DemoSetting.Insert(new DemoSetting { Key = SupervisorCodeKey, Value = "PCC2026" });
        Audit(ctx, SystemName, "DEMO_INIT", "Réseau TransVille initialisé (3 lignes, 18 arrêts, 5 véhicules).");
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientConnected)]
    public static void ClientConnected(ReducerContext ctx)
    {
        if (ctx.ConnectionId is not { } cid)
            return;
        ctx.Db.OnlinePresence.ConnectionId.Delete(cid);
        ctx.Db.OnlinePresence.Insert(new OnlinePresence { ConnectionId = cid, Identity = ctx.Sender, ConnectedAt = ctx.Timestamp });
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx)
    {
        if (ctx.ConnectionId is not { } cid)
            return;
        ctx.Db.OnlinePresence.ConnectionId.Delete(cid);
    }

    // ---------------------------------------------------------------- Users

    [SpacetimeDB.Reducer]
    public static void RegisterUser(ReducerContext ctx, string name, Role role, string accessCode)
    {
        name = CleanText(name, 2, 40, "Nom");
        if (role == Role.Supervisor)
        {
            var code = ctx.Db.DemoSetting.Key.Find(SupervisorCodeKey)?.Value;
            if (code is null || (accessCode ?? "").Trim() != code)
                throw new Exception("Code d'accès PCC invalide.");
        }

        if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is { } existing)
        {
            ctx.Db.AppUser.Identity.Update(existing with { Name = name, Role = role });
            if (role != Role.Driver && ctx.Db.DriverAssignment.DriverIdentity.Find(ctx.Sender) is { } a)
            {
                ctx.Db.DriverAssignment.VehicleId.Delete(a.VehicleId);
                Audit(ctx, name, "VEHICLE_RELEASED", $"{name} a libéré le Bus {a.VehicleId} (changement de rôle).");
            }
        }
        else
        {
            ctx.Db.AppUser.Insert(new AppUser { Identity = ctx.Sender, Name = name, Role = role, RegisteredAt = ctx.Timestamp });
        }
        Audit(ctx, name, "USER_REGISTERED", $"{name} s'est connecté(e) en tant que {RoleLabel(role)}.");
    }

    // ---------------------------------------------------------------- Vehicles

    [SpacetimeDB.Reducer]
    public static void ClaimVehicle(ReducerContext ctx, uint vehicleId)
    {
        var user = RequireRole(ctx, Role.Driver);
        var vehicle = RequireVehicle(ctx, vehicleId);
        if (ctx.Db.DriverAssignment.VehicleId.Find(vehicleId) is { } taken)
        {
            if (taken.DriverIdentity == ctx.Sender)
                return; // idempotent
            throw new Exception($"Le {vehicle.Label} est déjà pris par {taken.DriverName}.");
        }
        if (ctx.Db.DriverAssignment.DriverIdentity.Find(ctx.Sender) is { } previous)
            ctx.Db.DriverAssignment.VehicleId.Delete(previous.VehicleId);

        ctx.Db.DriverAssignment.Insert(new DriverAssignment
        {
            VehicleId = vehicleId,
            DriverIdentity = ctx.Sender,
            DriverName = user.Name,
            ClaimedAt = ctx.Timestamp,
        });
        Audit(ctx, user.Name, "VEHICLE_CLAIMED", $"{user.Name} a pris en charge le {vehicle.Label} (ligne {LineCode(ctx, vehicle.LineId)}).");
    }

    [SpacetimeDB.Reducer]
    public static void ReleaseVehicle(ReducerContext ctx)
    {
        var user = RequireRole(ctx, Role.Driver);
        if (ctx.Db.DriverAssignment.DriverIdentity.Find(ctx.Sender) is not { } a)
            throw new Exception("Vous n'avez pas de véhicule.");
        ctx.Db.DriverAssignment.VehicleId.Delete(a.VehicleId);
        Audit(ctx, user.Name, "VEHICLE_RELEASED", $"{user.Name} a libéré le Bus {a.VehicleId}.");
    }

    /// Supervisor-only: frees a bus held by a driver (typically a closed tab whose identity is gone for good).
    [SpacetimeDB.Reducer]
    public static void ForceReleaseVehicle(ReducerContext ctx, uint vehicleId)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        var vehicle = RequireVehicle(ctx, vehicleId);
        if (ctx.Db.DriverAssignment.VehicleId.Find(vehicleId) is not { } a)
            throw new Exception($"Le {vehicle.Label} n'a pas de chauffeur.");
        ctx.Db.DriverAssignment.VehicleId.Delete(vehicleId);
        Audit(ctx, user.Name, "VEHICLE_RELEASED", $"{user.Name} a libéré le {vehicle.Label} (retiré à {a.DriverName}).");
    }

    // ---------------------------------------------------------------- Incidents

    [SpacetimeDB.Reducer]
    public static void ReportIncident(ReducerContext ctx, IncidentKind kind, string description)
    {
        var user = RequireRole(ctx, Role.Driver);
        if (ctx.Db.DriverAssignment.DriverIdentity.Find(ctx.Sender) is not { } a)
            throw new Exception("Vous devez d'abord prendre un véhicule.");
        description = CleanText(description, 0, 280, "Description");
        var vehicle = RequireVehicle(ctx, a.VehicleId);
        var incident = CreateIncident(ctx, vehicle, kind, description, user.Name);
        Audit(ctx, user.Name, "INCIDENT_REPORTED",
            $"{user.Name} a signalé « {KindLabel(kind)} » sur le {vehicle.Label} (ligne {LineCode(ctx, vehicle.LineId)}), incident n° {incident.Id}.");
    }

    [SpacetimeDB.Reducer]
    public static void InjectRandomIncident(ReducerContext ctx)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        var vehicles = ctx.Db.Vehicle.Iter().OrderBy(v => v.Id).ToList();
        if (vehicles.Count == 0)
            throw new Exception("Aucun véhicule.");
        var vehicle = vehicles[ctx.Rng.Next(0, vehicles.Count)];
        var kind = (IncidentKind)ctx.Rng.Next(0, 5);
        var description = RandomDescriptions[ctx.Rng.Next(0, RandomDescriptions.Length)];
        var incident = CreateIncident(ctx, vehicle, kind, description, "Simulation");
        Audit(ctx, user.Name, "INCIDENT_INJECTED",
            $"{user.Name} a injecté un incident « {KindLabel(kind)} » sur le {vehicle.Label}, incident n° {incident.Id}.");
    }

    [SpacetimeDB.Reducer]
    public static void TakeIncident(ReducerContext ctx, ulong incidentId)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        if (ctx.Db.Incident.Id.Find(incidentId) is not { } inc)
            throw new Exception("Incident introuvable.");
        if (inc.Status != IncidentStatus.Open)
            throw new Exception(inc.Status == IncidentStatus.Resolved
                ? "Incident déjà résolu."
                : $"Incident déjà pris en charge par {inc.AssigneeName}.");
        ctx.Db.Incident.Id.Update(inc with
        {
            Status = IncidentStatus.InProgress,
            AssignedTo = ctx.Sender,
            AssigneeName = user.Name,
            UpdatedAt = ctx.Timestamp,
        });
        DeleteEscalations(ctx, incidentId);
        Audit(ctx, user.Name, "INCIDENT_TAKEN", $"{user.Name} a pris en charge l'incident n° {incidentId} ({KindLabel(inc.Kind)}, Bus {inc.VehicleId}).");
    }

    [SpacetimeDB.Reducer]
    public static void ResolveIncident(ReducerContext ctx, ulong incidentId, string note)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        if (ctx.Db.Incident.Id.Find(incidentId) is not { } inc)
            throw new Exception("Incident introuvable.");
        if (inc.Status == IncidentStatus.Resolved)
            throw new Exception("Incident déjà résolu.");
        note = CleanText(note, 0, 280, "Note");

        var updated = inc with { Status = IncidentStatus.Resolved, ResolvedAt = ctx.Timestamp, UpdatedAt = ctx.Timestamp };
        if (inc.Status == IncidentStatus.Open)
            updated = updated with { AssignedTo = ctx.Sender, AssigneeName = user.Name };
        ctx.Db.Incident.Id.Update(updated);
        DeleteEscalations(ctx, incidentId);

        // Retention: keep the most recent MaxResolvedIncidents resolved incidents.
        var resolved = ctx.Db.Incident.Iter()
            .Where(i => i.Status == IncidentStatus.Resolved)
            .OrderByDescending(i => i.ResolvedAt?.MicrosecondsSinceUnixEpoch ?? 0)
            .ThenByDescending(i => i.Id)
            .Skip(MaxResolvedIncidents)
            .ToList();
        foreach (var old in resolved)
            ctx.Db.Incident.Id.Delete(old.Id);

        Alert(ctx, "resolved", $"Incident résolu : {KindLabel(inc.Kind)}",
            $"Bus {inc.VehicleId} – Ligne {LineCode(ctx, inc.LineId)}", inc.Severity, inc.LineId);
        var details = $"{user.Name} a résolu l'incident n° {incidentId} ({KindLabel(inc.Kind)}, Bus {inc.VehicleId}).";
        if (note.Length > 0)
            details += $" Note : {note}";
        Audit(ctx, user.Name, "INCIDENT_RESOLVED", details);
    }

    [SpacetimeDB.Reducer]
    public static void EscalateIncident(ReducerContext ctx, IncidentEscalation row)
    {
        RequireScheduler(ctx);
        if (ctx.Db.Incident.Id.Find(row.IncidentId) is not { } inc || inc.Status != IncidentStatus.Open)
            return;
        var severity = inc.Severity < IncidentSeverity.Critical ? inc.Severity + 1 : IncidentSeverity.Critical;
        ctx.Db.Incident.Id.Update(inc with { Severity = severity, Escalations = inc.Escalations + 1, UpdatedAt = ctx.Timestamp });
        if (severity < IncidentSeverity.Critical)
            ScheduleEscalation(ctx, inc.Id);
        Alert(ctx, "escalation", "Escalade : incident non pris en charge",
            $"{KindLabel(inc.Kind)} – Bus {inc.VehicleId} – gravité {SeverityLabel(severity)}", severity, inc.LineId);
        Audit(ctx, SystemName, "INCIDENT_ESCALATED",
            $"Incident n° {inc.Id} non pris en charge : gravité portée à « {SeverityLabel(severity)} » (escalade n° {inc.Escalations + 1}).");
    }

    // ---------------------------------------------------------------- Messages

    [SpacetimeDB.Reducer]
    public static void SendDriverMessage(ReducerContext ctx, uint vehicleId, string body)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        body = CleanText(body, 1, 280, "Message");
        var vehicle = RequireVehicle(ctx, vehicleId);
        if (ctx.Db.DriverAssignment.VehicleId.Find(vehicleId) is not { } a)
            throw new Exception("Aucun chauffeur sur ce véhicule.");
        ctx.Db.DriverMessage.Insert(new DriverMessage
        {
            Id = 0,
            ToDriver = a.DriverIdentity, // recipient resolved server-side
            VehicleId = vehicleId,
            FromName = user.Name,
            Body = body,
            SentAt = ctx.Timestamp,
            Acknowledged = false,
            AcknowledgedAt = null,
        });
        var excess = (int)ctx.Db.DriverMessage.Count - MaxMessages;
        if (excess > 0)
        {
            var oldest = ctx.Db.DriverMessage.SentAt.Filter((MinTs, MaxTs))
                .OrderBy(m => m.SentAt.MicrosecondsSinceUnixEpoch).ThenBy(m => m.Id)
                .Take(excess).ToList();
            foreach (var m in oldest)
                ctx.Db.DriverMessage.Id.Delete(m.Id);
        }
        Audit(ctx, user.Name, "MESSAGE_SENT", $"{user.Name} a envoyé un message au chauffeur du {vehicle.Label} ({a.DriverName}).");
    }

    [SpacetimeDB.Reducer]
    public static void AcknowledgeMessage(ReducerContext ctx, ulong messageId)
    {
        var user = RequireRole(ctx, Role.Driver);
        if (ctx.Db.DriverMessage.Id.Find(messageId) is not { } m || m.ToDriver != ctx.Sender)
            throw new Exception("Message introuvable.");
        if (m.Acknowledged)
            return; // idempotent
        ctx.Db.DriverMessage.Id.Update(m with { Acknowledged = true, AcknowledgedAt = ctx.Timestamp });
        Audit(ctx, user.Name, "MESSAGE_ACK", $"{user.Name} a accusé réception d'un message du PCC (Bus {m.VehicleId}).");
    }

    // ---------------------------------------------------------------- Demo controls

    [SpacetimeDB.Reducer]
    public static void SetSimSpeed(ReducerContext ctx, uint factor)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        if (factor is not (1 or 2 or 5 or 10))
            throw new Exception("Vitesse invalide (1, 2, 5 ou 10).");
        var cfg = ctx.Db.SimConfig.Id.Find(0) ?? throw new Exception("Simulation non initialisée.");
        ctx.Db.SimConfig.Id.Update(cfg with { SpeedFactor = factor });
        Audit(ctx, user.Name, "SIM_SPEED", $"{user.Name} a réglé la simulation sur ×{factor}.");
    }

    [SpacetimeDB.Reducer]
    public static void SetSimPaused(ReducerContext ctx, bool paused)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        var cfg = ctx.Db.SimConfig.Id.Find(0) ?? throw new Exception("Simulation non initialisée.");
        ctx.Db.SimConfig.Id.Update(cfg with { Paused = paused });
        Audit(ctx, user.Name, "SIM_PAUSE", paused ? $"{user.Name} a mis la simulation en pause." : $"{user.Name} a relancé la simulation.");
    }

    [SpacetimeDB.Reducer]
    public static void ResetDemo(ReducerContext ctx)
    {
        var user = RequireRole(ctx, Role.Supervisor);
        foreach (var i in ctx.Db.Incident.Iter().ToList())
            ctx.Db.Incident.Id.Delete(i.Id);
        foreach (var e in ctx.Db.IncidentEscalation.Iter().ToList())
            ctx.Db.IncidentEscalation.ScheduledId.Delete(e.ScheduledId);
        foreach (var m in ctx.Db.DriverMessage.Iter().ToList())
            ctx.Db.DriverMessage.Id.Delete(m.Id);
        foreach (var e in ctx.Db.StopEta.Iter().ToList())
            ctx.Db.StopEta.Key.Delete(e.Key);
        foreach (var a in ctx.Db.AuditLog.Iter().ToList())
            ctx.Db.AuditLog.Id.Delete(a.Id);

        // Free buses held by drivers with no live connection (closed tabs never come back:
        // their identity lived in sessionStorage). Online drivers keep their bus.
        var ghostReleases = 0;
        foreach (var a in ctx.Db.DriverAssignment.Iter().ToList())
        {
            if (!ctx.Db.OnlinePresence.Identity.Filter(a.DriverIdentity).Any())
            {
                ctx.Db.DriverAssignment.VehicleId.Delete(a.VehicleId);
                ghostReleases++;
            }
        }

        SeedVehicles(ctx);

        if (ctx.Db.SimConfig.Id.Find(0) is { } cfg)
            ctx.Db.SimConfig.Id.Update(cfg with { SpeedFactor = 1, Paused = false });
        else
            ctx.Db.SimConfig.Insert(new SimConfig { Id = 0, SpeedFactor = 1, Paused = false, TickCount = 0, LastTickAt = ctx.Timestamp });

        var ticks = ctx.Db.SimTick.Iter().OrderBy(t => t.ScheduledId).ToList();
        if (ticks.Count == 0)
            ctx.Db.SimTick.Insert(new SimTick { ScheduledId = 0, ScheduledAt = new ScheduleAt.Interval(TimeSpan.FromSeconds(1)) });
        foreach (var extra in ticks.Skip(1))
            ctx.Db.SimTick.ScheduledId.Delete(extra.ScheduledId);

        Alert(ctx, "system", "Démo réinitialisée", $"Réinitialisée par {user.Name}.", IncidentSeverity.Low, 0);
        Audit(ctx, user.Name, "DEMO_RESET", $"{user.Name} a réinitialisé la démo.");
        if (ghostReleases > 0)
            Audit(ctx, user.Name, "VEHICLE_RELEASED", $"{ghostReleases} véhicule(s) libéré(s) : chauffeur(s) hors ligne.");
    }
}
