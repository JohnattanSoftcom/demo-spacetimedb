// TransVille Live — SpacetimeDB module (tables & domain types).
// Reducers: Reducers.cs, simulation: Simulation.cs, seed data: Seed.cs, views: Views.cs.
using SpacetimeDB;

public static partial class Module
{
    // ---------------------------------------------------------------- Domain types

    [SpacetimeDB.Type]
    public enum Role { Supervisor, Driver, Passenger }

    [SpacetimeDB.Type]
    public enum IncidentKind { Breakdown, Accident, Assault, PassengerIllness, Delay }

    [SpacetimeDB.Type]
    public enum IncidentSeverity { Low, Medium, High, Critical }

    [SpacetimeDB.Type]
    public enum IncidentStatus { Open, InProgress, Resolved }

    [SpacetimeDB.Type]
    public enum VehicleStatus { EnRoute, AtStop, Layover, Immobilized }

    // ---------------------------------------------------------------- Reference network (public)

    [SpacetimeDB.Table(Accessor = "Line", Public = true)]
    public partial struct Line
    {
        [PrimaryKey]
        public uint Id;
        public string Code;
        public string Name;
        public string Color;
    }

    [SpacetimeDB.Table(Accessor = "Stop", Public = true)]
    public partial struct Stop
    {
        [PrimaryKey]
        public uint Id;
        public string Name;
        public double Lat;
        public double Lon;
    }

    [SpacetimeDB.Table(Accessor = "LineStop", Public = true)]
    public partial struct LineStop
    {
        [PrimaryKey]
        public uint Id; // LineId * 100 + Seq
        [SpacetimeDB.Index.BTree]
        public uint LineId;
        [SpacetimeDB.Index.BTree]
        public uint StopId;
        public uint Seq;
        public double DistanceToNextM;
    }

    [SpacetimeDB.Table(Accessor = "Vehicle", Public = true)]
    public partial struct Vehicle
    {
        [PrimaryKey]
        public uint Id;
        public string Label;
        [SpacetimeDB.Index.BTree]
        public uint LineId;
        public string Model;
    }

    // ---------------------------------------------------------------- Live vehicle state

    /// Hot data, rewritten every tick. Kept apart from Vehicle metadata.
    [SpacetimeDB.Table(Accessor = "VehiclePosition", Public = true)]
    public partial struct VehiclePosition
    {
        [PrimaryKey]
        public uint VehicleId;
        public uint LineId;
        public double Lat;
        public double Lon;
        public double Heading;
        public VehicleStatus Status;
        public uint NextStopId;
        public bool Forward;
        public int DelaySeconds;
        public Timestamp UpdatedAt;
    }

    /// Private simulation internals.
    [SpacetimeDB.Table(Accessor = "VehicleSimState")]
    public partial struct VehicleSimState
    {
        [PrimaryKey]
        public uint VehicleId;
        public int FromSeq;
        public bool Forward;
        public double ProgressM;
        public double DwellRemainingS;
        public double LayoverRemainingS;
        public double TripElapsedS;
        public double PlannedElapsedS;
    }

    /// One driver per bus (PK) and one bus per driver (Unique): double claims are impossible.
    [SpacetimeDB.Table(Accessor = "DriverAssignment", Public = true)]
    public partial struct DriverAssignment
    {
        [PrimaryKey]
        public uint VehicleId;
        [Unique]
        public Identity DriverIdentity;
        public string DriverName;
        public Timestamp ClaimedAt;
    }

    // ---------------------------------------------------------------- Users & presence

    [SpacetimeDB.Table(Accessor = "AppUser", Public = true)]
    public partial struct AppUser
    {
        [PrimaryKey]
        public Identity Identity;
        public string Name;
        public Role Role;
        public Timestamp RegisteredAt;
    }

    [SpacetimeDB.Table(Accessor = "OnlinePresence", Public = true)]
    public partial struct OnlinePresence
    {
        [PrimaryKey]
        public ConnectionId ConnectionId;
        [SpacetimeDB.Index.BTree]
        public Identity Identity;
        public Timestamp ConnectedAt;
    }

    /// Private: never replicated to clients.
    [SpacetimeDB.Table(Accessor = "DemoSetting")]
    public partial struct DemoSetting
    {
        [PrimaryKey]
        public string Key;
        public string Value;
    }

    // ---------------------------------------------------------------- Operations

    [SpacetimeDB.Table(Accessor = "Incident", Public = true)]
    public partial struct Incident
    {
        [PrimaryKey]
        [AutoInc]
        public ulong Id;
        public IncidentKind Kind;
        public IncidentSeverity Severity;
        public IncidentStatus Status;
        [SpacetimeDB.Index.BTree]
        public uint LineId;
        [SpacetimeDB.Index.BTree]
        public uint VehicleId;
        public double Lat;
        public double Lon;
        public string Description;
        public Identity ReportedBy;
        public string ReporterName;
        public Timestamp ReportedAt;
        public Identity? AssignedTo;
        public string AssigneeName;
        public uint Escalations;
        public Timestamp UpdatedAt;
        public Timestamp? ResolvedAt;
    }

    /// One-shot scheduled escalation (chained every EscalationDelay while the incident stays open).
    [SpacetimeDB.Table(
        Accessor = "IncidentEscalation",
        Scheduled = nameof(EscalateIncident),
        ScheduledAt = nameof(ScheduledAt)
    )]
    public partial struct IncidentEscalation
    {
        [PrimaryKey]
        [AutoInc]
        public ulong ScheduledId;
        public ScheduleAt ScheduledAt;
        [SpacetimeDB.Index.BTree]
        public ulong IncidentId;
    }

    /// Private; exposed through the MyMessages / SupervisorMessages views.
    [SpacetimeDB.Table(Accessor = "DriverMessage")]
    public partial struct DriverMessage
    {
        [PrimaryKey]
        [AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public Identity ToDriver;
        public uint VehicleId;
        public string FromName;
        public string Body;
        [SpacetimeDB.Index.BTree]
        public Timestamp SentAt;
        public bool Acknowledged;
        public Timestamp? AcknowledgedAt;
    }

    /// Private; exposed to supervisors only through the AuditTrail view.
    [SpacetimeDB.Table(Accessor = "AuditLog")]
    public partial struct AuditLog
    {
        [PrimaryKey]
        [AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public Timestamp At;
        public Identity Actor;
        public string ActorName;
        public string Action;
        public string Details;
    }

    /// Event table: broadcast to subscribers, never stored in client caches.
    [SpacetimeDB.Table(Accessor = "AlertEvent", Public = true, Event = true)]
    public partial struct AlertEvent
    {
        public string Kind;
        public string Title;
        public string Body;
        public IncidentSeverity Severity;
        public uint LineId;
        public Timestamp At;
    }

    // ---------------------------------------------------------------- Simulation control

    [SpacetimeDB.Table(Accessor = "SimConfig", Public = true)]
    public partial struct SimConfig
    {
        [PrimaryKey]
        public uint Id;
        public uint SpeedFactor;
        public bool Paused;
        public ulong TickCount;
        public Timestamp LastTickAt;
    }

    [SpacetimeDB.Table(
        Accessor = "SimTick",
        Scheduled = nameof(SimulationTick),
        ScheduledAt = nameof(ScheduledAt)
    )]
    public partial struct SimTick
    {
        [PrimaryKey]
        [AutoInc]
        public ulong ScheduledId;
        public ScheduleAt ScheduledAt;
    }

    [SpacetimeDB.Table(Accessor = "StopEta", Public = true)]
    public partial struct StopEta
    {
        [PrimaryKey]
        public string Key;
        [SpacetimeDB.Index.BTree]
        public uint StopId;
        [SpacetimeDB.Index.BTree]
        public uint VehicleId;
        public uint LineId;
        public bool Forward;
        public string Destination;
        public int EtaSeconds;
        public bool Disrupted;
        public int DelaySeconds;
    }
}
