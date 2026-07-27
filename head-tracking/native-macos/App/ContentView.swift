import SwiftUI

struct ContentView: View {
    @ObservedObject var model: TrackerViewModel

    var body: some View {
        VStack(spacing: 22) {
            header

            HStack(spacing: 12) {
                angleCard("Yaw", value: model.pose.yaw)
                angleCard("Pitch", value: model.pose.pitch)
                angleCard("Roll", value: model.pose.roll)
            }

            HStack {
                Label(
                    "\(model.pose.packetsPerSecond, specifier: "%.1f") samples/s",
                    systemImage: "waveform.path.ecg"
                )
                Spacer()
                Button("Recenter", systemImage: "scope") {
                    model.recenter()
                }
                .disabled(!model.state.isConnected)
            }

            Divider()

            HStack {
                Text("Direct headphone connection · no UDP bridge")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if model.state.isConnected {
                    Button("Stop") { model.stop() }
                } else {
                    Button("Start Tracking") { model.start() }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(28)
        .frame(minWidth: 680, minHeight: 380)
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "airpodsmax")
                .font(.system(size: 32))
                .foregroundStyle(.blue)
                .frame(width: 54, height: 54)
                .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))

            VStack(alignment: .leading, spacing: 4) {
                Text("Spatial Head Tracking")
                    .font(.title2.bold())
                Text(model.state.title)
                    .foregroundStyle(model.state.isConnected ? .green : .secondary)
            }
            Spacer()
            Circle()
                .fill(model.state.isConnected ? .green : .gray)
                .frame(width: 10, height: 10)
        }
    }

    private func angleCard(_ label: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("\(value, specifier: "%+.1f")°")
                .font(.system(size: 32, weight: .medium, design: .rounded))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
    }
}
