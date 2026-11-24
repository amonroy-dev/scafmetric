"""Solve a simply supported beam with OpenSees.

    python solve_beam.py <beam.json>

Reads { spanFt, uniformLoadPlf, pointLoads: [{ loadLb, locationFt }], Eksi,
Iin4, stiffnessFactor, stationsFt } and writes <beam>.result.json with the two
reactions and, at every station, the bending moment and the deflection.
Inches and pounds inside. The stiffness is Eksi * Iin4 * stiffnessFactor, so
the deflections are the reduced ones the beam check reports.
"""
import json
import sys

import openseespy.opensees as ops


def main(path):
    with open(path, encoding='utf-8') as handle:
        beam = json.load(handle)
    span = beam['spanFt'] * 12.0
    # A node at every station asked for, at every load, and every 3 in between.
    stations = {0.0, span}
    stations.update(round(x * 12.0, 6) for x in beam['stationsFt'])
    stations.update(round(p['locationFt'] * 12.0, 6) for p in beam['pointLoads'])
    x = 0.0
    while x < span:
        stations.add(round(x, 6))
        x += 3.0
    xs = sorted(stations)

    ops.wipe()
    ops.model('basic', '-ndm', 2, '-ndf', 3)
    for i, x in enumerate(xs):
        ops.node(i + 1, x, 0.0)
    ops.fix(1, 1, 1, 0)
    ops.fix(len(xs), 0, 1, 0)
    ops.geomTransf('Linear', 1)
    modulus = beam['Eksi'] * 1000.0
    inertia = beam['Iin4'] * beam['stiffnessFactor']
    for i in range(len(xs) - 1):
        ops.element('elasticBeamColumn', i + 1, i + 1, i + 2, 1000.0, modulus, inertia, 1)

    ops.timeSeries('Constant', 1)
    ops.pattern('Plain', 1, 1)
    per_inch = beam['uniformLoadPlf'] / 12.0
    if per_inch:
        ops.eleLoad('-ele', *range(1, len(xs)), '-type', '-beamUniform', -per_inch)
    for load in beam['pointLoads']:
        ops.load(xs.index(round(load['locationFt'] * 12.0, 6)) + 1, 0.0, -load['loadLb'], 0.0)

    ops.system('BandGeneral')
    ops.numberer('RCM')
    ops.constraints('Plain')
    ops.integrator('LoadControl', 1.0)
    ops.algorithm('Linear')
    ops.analysis('Static')
    if ops.analyze(1) != 0:
        raise SystemExit('OpenSees could not solve the beam')
    ops.reactions()

    out = {'opensees': ops.version(), 'leftLb': ops.nodeReaction(1)[1], 'rightLb': ops.nodeReaction(len(xs))[1], 'stations': []}
    for station in beam['stationsFt']:
        node = xs.index(round(station * 12.0, 6)) + 1
        # The moment in the beam at a node: the end moment of the element on its
        # left (or, at the left support, of the first element).
        if node == 1:
            moment = -ops.eleForce(1)[2]
        else:
            moment = ops.eleForce(node - 1)[5]
        out['stations'].append({'xFt': station, 'momentLbIn': moment, 'deflectionIn': -ops.nodeDisp(node, 2)})

    with open(path.replace('.json', '.result.json'), 'w', encoding='utf-8') as handle:
        json.dump(out, handle, indent=1)
    print('solved', path)


if __name__ == '__main__':
    main(sys.argv[1])
