# Bloch Pilot

Steer one qubit through a quantum obstacle course on the Meta Quest 3.

Built for the **Quantum in the Metaverse** track, Qiskit Fall Fest 2026 at Khalifa University.

- Five gates: X, H, Z, S, RY(π/4)
- A tutorial and three scored levels, the last one being "Invisible Phase", where you see only the measurement odds
- Score: fidelity first, then spare gates, then time
- Gate matrices and level targets checked against Qiskit statevectors

Play: open the GitHub Pages link in the Quest 3 browser and press **Enter VR**. You stand on the tip of the qubit's state vector, on a glass Bloch sphere that turns under your feet with every gate. The **OUTSIDE VIEW** button switches to watching the sphere from outside. It also runs in a laptop browser (click the buttons, drag to look around).

Options: `?minutes=15` sets the run length; `?view=outside` starts in the outside view; `?log=1` shows the results saved on that device. Staff pick the headset number once on the start page.

Uses three.js r170 (MIT).
