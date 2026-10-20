using SpacetimeDB;

public static partial class Module
{
    const double NominalSpeedMps = 6.0;
    const double PlannedDwellS = 20;
    const double LayoverS = 60;
    const double EtaHorizonS = 1800;

    sealed class Network
    {
        public Dictionary<uint, List<LineStop>> Routes = new();
        public Dictionary<uint, Stop> Stops = new();
    }

    static Network LoadNetwork(ReducerContext ctx)
    {
        var net = new Network();
        foreach (var s in ctx.Db.Stop.Iter())
            net.Stops[s.Id] = s;
        foreach (var l in ctx.Db.Line.Iter())
            net.Routes[l.Id] = ctx.Db.LineStop.LineId.Filter(l.Id).OrderBy(s => s.Seq).ToList();
        return net;
    }

    static bool IsEnd(List<LineStop> route, int seq, bool forward) =>
        forward ? seq >= route.Count - 1 : seq <= 0;

    static double SegmentLength(List<LineStop> route, int fromSeq, bool forward)
    {
        if (IsEnd(route, fromSeq, forward))
            return 0;
        return forward ? route[fromSeq].DistanceToNextM : route[fromSeq - 1].DistanceToNextM;
    }

    /// Timetable seconds elapsed since trip start for the current position.
    static double PlannedElapsed(List<LineStop> route, VehicleSimState s)
    {
        var origin = s.Forward ? 0 : route.Count - 1;
        var completed = Math.Abs(s.FromSeq - origin);
        double planned = 0;
        var seq = origin;
        for (var i = 0; i < completed; i++)
        {
            planned += SegmentLength(route, seq, s.Forward) / NominalSpeedMps;
            seq += s.Forward ? 1 : -1;
        }
        if (s.LayoverRemainingS > 0)
            planned += Math.Max(0, completed - 1) * PlannedDwellS;
        else if (s.DwellRemainingS > 0)
            planned += Math.Max(0, completed - 1) * PlannedDwellS + Math.Max(0, PlannedDwellS - s.DwellRemainingS);
        else
            planned += completed * PlannedDwellS + s.ProgressM / NominalSpeedMps;
        return planned;
    }

    /// Direction the vehicle will depart in (flips while laying over at the end terminus).
    static bool EffectiveForward(List<LineStop> route, VehicleSimState s) =>
        s.LayoverRemainingS > 0 && IsEnd(route, s.FromSeq, s.Forward) ? !s.Forward : s.Forward;

    static VehiclePosition ComputePosition(ReducerContext ctx, Network net, Vehicle vehicle, VehicleSimState s, bool immobilized)
    {
        var route = net.Routes[vehicle.LineId];
        var forward = EffectiveForward(route, s);
        var from = net.Stops[route[s.FromSeq].StopId];
        var lat = from.Lat;
        var lon = from.Lon;
        double heading = 0;
        var nextStopId = from.Id;

        if (!IsEnd(route, s.FromSeq, forward))
        {
            var nextSeq = s.FromSeq + (forward ? 1 : -1);
            var to = net.Stops[route[nextSeq].StopId];
            var dx = (to.Lon - from.Lon) * Math.Cos(RefLatRad);
            var dy = to.Lat - from.Lat;
            heading = (Math.Atan2(dx, dy) * 180.0 / Math.PI + 360.0) % 360.0;
            var moving = s.DwellRemainingS <= 0 && s.LayoverRemainingS <= 0;
            if (moving)
            {
                var len = SegmentLength(route, s.FromSeq, forward);
                var f = len > 0 ? Math.Clamp(s.ProgressM / len, 0, 1) : 0;
                lat = from.Lat + (to.Lat - from.Lat) * f;
                lon = from.Lon + (to.Lon - from.Lon) * f;
                nextStopId = to.Id;
            }
        }

        var status =
            immobilized ? VehicleStatus.Immobilized
            : s.LayoverRemainingS > 0 ? VehicleStatus.Layover
            : s.DwellRemainingS > 0 ? VehicleStatus.AtStop
            : VehicleStatus.EnRoute;

        return new VehiclePosition
        {
            VehicleId = vehicle.Id,
            LineId = vehicle.LineId,
            Lat = lat,
            Lon = lon,
            Heading = heading,
            Status = status,
            NextStopId = nextStopId,
            Forward = forward,
            DelaySeconds = (int)Math.Round(s.TripElapsedS - s.PlannedElapsedS),
            UpdatedAt = ctx.Timestamp,
        };
    }

    [SpacetimeDB.Reducer]
    public static void SimulationTick(ReducerContext ctx, SimTick row)
    {
        RequireScheduler(ctx);
        if (ctx.Db.SimConfig.Id.Find(0) is not { } cfg || cfg.Paused)
            return;
        double dt = cfg.SpeedFactor;
        ctx.Db.SimConfig.Id.Update(cfg with { TickCount = cfg.TickCount + 1, LastTickAt = ctx.Timestamp });

        var net = LoadNetwork(ctx);
        var states = ctx.Db.VehicleSimState.Iter().OrderBy(v => v.VehicleId).ToList();
        foreach (var current in states)
        {
            if (ctx.Db.Vehicle.Id.Find(current.VehicleId) is not { } vehicle)
                continue;
            if (!net.Routes.TryGetValue(vehicle.LineId, out var route) || route.Count < 2)
                continue;
            var s = current;

            // Blocking incidents
            var immobilized = false;
            var speedFactor = 1.0;
            foreach (var inc in ctx.Db.Incident.VehicleId.Filter(vehicle.Id))
            {
                if (inc.Status == IncidentStatus.Resolved)
                    continue;
                if (inc.Kind == IncidentKind.Delay)
                    speedFactor = 0.5;
                else
                    immobilized = true;
            }

            // Drawn once per vehicle per tick (deterministic consumption order).
            var velocity = NominalSpeedMps * speedFactor * (0.80 + 0.30 * ctx.Rng.NextDouble());

            if (immobilized)
            {
                s.TripElapsedS += dt;
            }
            else
            {
                var budget = dt;
                var guard = 0;
                while (budget > 1e-9 && guard++ < 64)
                {
                    if (s.LayoverRemainingS > 0)
                    {
                        var c = Math.Min(budget, s.LayoverRemainingS);
                        s.LayoverRemainingS -= c;
                        budget -= c;
                        if (s.LayoverRemainingS <= 1e-9)
                        {
                            s.LayoverRemainingS = 0;
                            if (IsEnd(route, s.FromSeq, s.Forward))
                                s.Forward = !s.Forward;
                            s.TripElapsedS = 0; // new trip: the layover absorbed the delay
                            s.ProgressM = 0;
                        }
                    }
                    else if (s.DwellRemainingS > 0)
                    {
                        var c = Math.Min(budget, s.DwellRemainingS);
                        s.DwellRemainingS -= c;
                        budget -= c;
                        s.TripElapsedS += c;
                        if (s.DwellRemainingS <= 1e-9)
                            s.DwellRemainingS = 0;
                    }
                    else
                    {
                        if (IsEnd(route, s.FromSeq, s.Forward))
                        {
                            // Defensive: standing at an end terminus without layover → turn around.
                            s.Forward = !s.Forward;
                            s.TripElapsedS = 0;
                            s.ProgressM = 0;
                            continue;
                        }
                        var len = SegmentLength(route, s.FromSeq, s.Forward);
                        var needed = Math.Max(0, len - s.ProgressM) / velocity;
                        if (needed <= budget)
                        {
                            budget -= needed;
                            s.TripElapsedS += needed;
                            s.FromSeq += s.Forward ? 1 : -1;
                            s.ProgressM = 0;
                            if (IsEnd(route, s.FromSeq, s.Forward))
                                s.LayoverRemainingS = LayoverS;
                            else
                                s.DwellRemainingS = 12 + ctx.Rng.NextDouble() * 18;
                        }
                        else
                        {
                            s.ProgressM += velocity * budget;
                            s.TripElapsedS += budget;
                            budget = 0;
                        }
                    }
                }
            }

            s.PlannedElapsedS = PlannedElapsed(route, s);
            ctx.Db.VehicleSimState.VehicleId.Update(s);
            var pos = ComputePosition(ctx, net, vehicle, s, immobilized);
            ctx.Db.VehiclePosition.VehicleId.Update(pos);

            UpdateStopEtas(ctx, net, route, vehicle, s, immobilized, pos.DelaySeconds);
        }
    }

    static void UpdateStopEtas(ReducerContext ctx, Network net, List<LineStop> route, Vehicle vehicle, VehicleSimState s, bool immobilized, int delay)
    {
        var wanted = new List<StopEta>();
        string Destination(bool fwd) => net.Stops[route[fwd ? route.Count - 1 : 0].StopId].Name;
        void Emit(int seq, bool fwd, double t)
        {
            var stopId = route[seq].StopId;
            wanted.Add(new StopEta
            {
                Key = $"{stopId}-{vehicle.Id}-{(fwd ? "F" : "B")}",
                StopId = stopId,
                VehicleId = vehicle.Id,
                LineId = vehicle.LineId,
                Forward = fwd,
                Destination = Destination(fwd),
                EtaSeconds = (int)(t / 10) * 10,
                Disrupted = immobilized,
                DelaySeconds = delay,
            });
        }

        var pos = s.FromSeq;
        var dir = s.Forward;
        double t;
        if (s.LayoverRemainingS > 0)
        {
            if (IsEnd(route, pos, dir))
                dir = !dir;
            t = s.LayoverRemainingS;
            Emit(pos, dir, t);
        }
        else if (s.DwellRemainingS > 0)
        {
            Emit(pos, dir, 0); // "À quai"
            t = s.DwellRemainingS;
        }
        else
        {
            if (IsEnd(route, pos, dir))
                dir = !dir;
            t = -s.ProgressM / NominalSpeedMps; // the loop adds the full segment
        }

        var reversals = 0;
        var guard = 0;
        while (guard++ < 64)
        {
            if (IsEnd(route, pos, dir))
                break;
            t += SegmentLength(route, pos, dir) / NominalSpeedMps;
            pos += dir ? 1 : -1;
            if (t > EtaHorizonS)
                break;
            if (IsEnd(route, pos, dir))
            {
                if (reversals >= 1)
                    break; // reverse direction complete
                t += LayoverS;
                dir = !dir;
                reversals++;
                if (t > EtaHorizonS)
                    break;
                Emit(pos, dir, t); // first departure of the other direction
            }
            else
            {
                Emit(pos, dir, t);
                t += PlannedDwellS;
            }
        }

        var existing = ctx.Db.StopEta.VehicleId.Filter(vehicle.Id).ToList();
        var wantedKeys = new HashSet<string>(wanted.Select(w => w.Key));
        foreach (var old in existing)
            if (!wantedKeys.Contains(old.Key))
                ctx.Db.StopEta.Key.Delete(old.Key);
        foreach (var w in wanted)
        {
            var old = existing.FirstOrDefault(e => e.Key == w.Key);
            if (old.Key is null)
                ctx.Db.StopEta.Insert(w);
            else if (old.EtaSeconds != w.EtaSeconds || old.Disrupted != w.Disrupted || old.DelaySeconds != w.DelaySeconds || old.Destination != w.Destination)
                ctx.Db.StopEta.Key.Update(w);
        }
    }
}
