# Bloch Pilot

Steer one qubit through a quantum obstacle course on the Meta Quest 3.

Built for the **Quantum in the Metaverse** track, Qiskit Fall Fest 2026 at Khalifa University.

- Five gates: X, H, Z, S, RY(π/4)
- Two rounds, picked on the start page: the **tutorial round** (a warm-up and three scored levels, ending with "Invisible Phase", where you see only the measurement odds) and the **challenge round** (five harder scored levels)
- Score: fidelity first, then spare gates, then time
- Gate matrices and level targets checked against Qiskit statevectors

Play: open the GitHub Pages link in the Quest 3 browser and press **Enter VR**. You stand in the middle of a big Bloch sphere; the orange arrow coming out of your chest is the qubit's state vector. The **OUTSIDE VIEW** button switches to watching the sphere from outside. It also runs in a laptop browser (click the buttons, drag to look around).

Options: `?minutes=15` sets the run length; `?view=outside` starts in the outside view (`?view=tip` puts you on the tip of the arrow); `?round=challenge` picks the round; `?log=1` shows the results saved on that device. Staff pick the headset number once on the start page.

Uses three.js r170 (MIT).
