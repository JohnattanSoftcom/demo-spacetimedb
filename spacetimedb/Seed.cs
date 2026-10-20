using SpacetimeDB;

public static partial class Module
{
    const double RefLatRad = 46.80 * Math.PI / 180.0;

    static double DistanceM(double lat1, double lon1, double lat2, double lon2)
    {
        var dx = (lon2 - lon1) * 111_320 * Math.Cos(RefLatRad);
        var dy = (lat2 - lat1) * 110_540;
        return Math.Sqrt(dx * dx + dy * dy);
    }

    static readonly (uint Id, string Name, double Lat, double Lon)[] SeedStops =
    {
        (1, "Marly, Centre", 46.7765, 7.1595),
        (2, "Marly, Gérine", 46.7835, 7.1555),
        (3, "Pérolles, Université", 46.7935, 7.1545),
        (4, "Charmettes", 46.7985, 7.1525),
        (5, "Fribourg, Gare", 46.8030, 7.1513),
        (6, "Miséricorde", 46.8065, 7.1495),
        (7, "Saint-Léonard", 46.8165, 7.1555),
        (8, "Villars-sur-Glâne, Moncor", 46.7925, 7.1215),
        (9, "Hôpital cantonal", 46.7995, 7.1325),
        (10, "Beauregard", 46.7995, 7.1435),
        (11, "Place Georges-Python", 46.8048, 7.1565),
        (12, "Tilleul / Cathédrale", 46.8062, 7.1625),
        (13, "Pont de Zaehringen", 46.8080, 7.1660),
        (14, "Schoenberg", 46.8125, 7.1775),
        (15, "Jura", 46.8155, 7.1440),
        (16, "Guintzet", 46.8085, 7.1430),
        (17, "Basse-Ville, Planche", 46.8025, 7.1650),
        (18, "Bourguillon", 46.7990, 7.1790),
    };

    static readonly (uint Id, string Code, string Name, string Color, uint[] Stops)[] SeedLines =
    {
        (1, "1", "Marly – Saint-Léonard", "#D7263D", new uint[] { 1, 2, 3, 4, 5, 6, 7 }),
        (2, "2", "Moncor – Schoenberg", "#1B65A6", new uint[] { 8, 9, 10, 5, 11, 12, 13, 14 }),
        (3, "3", "Jura – Bourguillon", "#F18F01", new uint[] { 15, 16, 6, 5, 11, 17, 18 }),
    };

    static readonly (uint Id, uint LineId, string Model)[] SeedVehicleList =
    {
        (101, 1, "Articulé 18 m"),
        (102, 1, "Articulé 18 m"),
        (201, 2, "Standard 12 m"),
        (202, 2, "Standard 12 m"),
        (301, 3, "Midibus 10 m"),
    };

    // VehicleId, Forward, FromSeq, ProgressM, LayoverS
    static readonly (uint VehicleId, bool Forward, int FromSeq, double ProgressM, double LayoverS)[] SeedStates =
    {
        (101, true, 0, 0, 10),
        (102, false, 4, 200, 0),
        (201, true, 1, 300, 0),
        (202, false, 6, 100, 0),
        (301, true, 2, 150, 0),
    };

    static void SeedNetwork(ReducerContext ctx)
    {
        foreach (var s in SeedStops)
            ctx.Db.Stop.Insert(new Stop { Id = s.Id, Name = s.Name, Lat = s.Lat, Lon = s.Lon });

        foreach (var l in SeedLines)
        {
            ctx.Db.Line.Insert(new Line { Id = l.Id, Code = l.Code, Name = l.Name, Color = l.Color });
            for (var i = 0; i < l.Stops.Length; i++)
            {
                double dist = 0;
                if (i < l.Stops.Length - 1)
                {
                    var a = SeedStops.First(s => s.Id == l.Stops[i]);
                    var b = SeedStops.First(s => s.Id == l.Stops[i + 1]);
                    dist = DistanceM(a.Lat, a.Lon, b.Lat, b.Lon);
                }
                ctx.Db.LineStop.Insert(new LineStop
                {
                    Id = l.Id * 100 + (uint)i,
                    LineId = l.Id,
                    StopId = l.Stops[i],
                    Seq = (uint)i,
                    DistanceToNextM = dist,
                });
            }
        }

        foreach (var v in SeedVehicleList)
            ctx.Db.Vehicle.Insert(new Vehicle { Id = v.Id, Label = $"Bus {v.Id}", LineId = v.LineId, Model = v.Model });
    }

    /// Deterministic starting states (no Rng) so that a reset is reproducible.
    static void SeedVehicles(ReducerContext ctx)
    {
        var net = LoadNetwork(ctx);
        foreach (var seed in SeedStates)
        {
            if (ctx.Db.Vehicle.Id.Find(seed.VehicleId) is not { } vehicle)
                continue;
            var state = new VehicleSimState
            {
                VehicleId = seed.VehicleId,
                FromSeq = seed.FromSeq,
                Forward = seed.Forward,
                ProgressM = seed.ProgressM,
                DwellRemainingS = 0,
                LayoverRemainingS = seed.LayoverS,
                TripElapsedS = 0,
                PlannedElapsedS = 0,
            };
            var route = net.Routes[vehicle.LineId];
            state.PlannedElapsedS = PlannedElapsed(route, state);
            state.TripElapsedS = state.PlannedElapsedS; // start on time

            if (ctx.Db.VehicleSimState.VehicleId.Find(seed.VehicleId) is not null)
                ctx.Db.VehicleSimState.VehicleId.Update(state);
            else
                ctx.Db.VehicleSimState.Insert(state);

            var pos = ComputePosition(ctx, net, vehicle, state, false);
            if (ctx.Db.VehiclePosition.VehicleId.Find(seed.VehicleId) is not null)
                ctx.Db.VehiclePosition.VehicleId.Update(pos);
            else
                ctx.Db.VehiclePosition.Insert(pos);
        }
    }
}
