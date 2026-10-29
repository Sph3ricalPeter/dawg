// Opens WAV and MP3 assets in dawg when you double-click them in Unity.
//
// Unity's External Tools only has an image application setting; audio opens
// with whatever Windows associates with the extension. This script takes
// over the double-click for .wav and .mp3 instead, so the rest of Windows
// keeps its own default player.
//
// Drop this file into any Editor folder of a project (for example
// Assets/Editor/DawgAudioEditor.cs). Settings live under
// Edit > Preferences > dawg. dawg opens the clip in its scratch session; Export
// defaults to the same file, and Unity reimports it when you switch back.

using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEngine;

namespace Dawg.Editor
{
    public static class DawgAudioEditor
    {
        const string EnabledKey = "dawg.openAudio";
        const string ExeKey = "dawg.exePath";

        static bool Enabled
        {
            get => EditorPrefs.GetBool(EnabledKey, true);
            set => EditorPrefs.SetBool(EnabledKey, value);
        }

        /// <summary>The chosen dawg.exe, else the first installed one found.</summary>
        static string ExePath
        {
            get
            {
                var chosen = EditorPrefs.GetString(ExeKey, "");
                return chosen != "" ? chosen : FindInstalled();
            }
            set => EditorPrefs.SetString(ExeKey, value);
        }

        /// <summary>The per-user installs: the released "dawg", then "dawg dev".</summary>
        static string FindInstalled()
        {
            var local = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
            foreach (var product in new[] { "dawg", "dawg dev" })
            {
                var exe = Path.Combine(local, product, "dawg.exe");
                if (File.Exists(exe)) return exe;
            }
            return "";
        }

        [OnOpenAsset]
        static bool OnOpenAsset(int instanceId, int line)
        {
            if (!Enabled) return false;
            if (!(EditorUtility.InstanceIDToObject(instanceId) is AudioClip)) return false;
            var asset = AssetDatabase.GetAssetPath(instanceId);
            var ext = Path.GetExtension(asset).ToLowerInvariant();
            if (ext != ".wav" && ext != ".wave" && ext != ".mp3") return false;

            var exe = ExePath;
            if (exe == "" || !File.Exists(exe))
            {
                UnityEngine.Debug.LogWarning("dawg isn't installed where expected. Pick dawg.exe under Edit > Preferences > dawg.");
                return false;
            }
            // dawg runs one window: a second launch hands it the file.
            Process.Start(new ProcessStartInfo(exe, $"\"{Path.GetFullPath(asset)}\"") { UseShellExecute = false });
            return true;
        }

        [SettingsProvider]
        static SettingsProvider Preferences() => new SettingsProvider("Preferences/dawg", SettingsScope.User)
        {
            label = "dawg",
            keywords = new[] { "dawg", "audio", "external", "editor", "wav", "mp3" },
            guiHandler = _ =>
            {
                Enabled = EditorGUILayout.Toggle("Open audio in dawg", Enabled);
                EditorGUILayout.BeginHorizontal();
                var exe = EditorGUILayout.TextField("dawg.exe", ExePath);
                if (exe != ExePath) ExePath = exe;
                if (GUILayout.Button("Browse…", GUILayout.Width(80)))
                {
                    var picked = EditorUtility.OpenFilePanel("dawg.exe", Path.GetDirectoryName(ExePath) ?? "", "exe");
                    if (picked != "") ExePath = picked;
                }
                EditorGUILayout.EndHorizontal();
                if (!File.Exists(ExePath))
                    EditorGUILayout.HelpBox("dawg.exe not found. Install dawg or browse to it.", MessageType.Warning);
            },
        };
    }
}
