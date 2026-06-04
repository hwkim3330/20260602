{
  "targets": [
    {
      "target_name": "sendqueue",
      "sources": [ "sendqueue.cc" ],
      "include_dirs": [ "<!(node -e \"require('nan')\")" ],
      "conditions": [
        [ "OS=='win'", {
          "include_dirs": [ "deps/winpcap/Include" ],
          "defines": [ "WPCAP", "HAVE_REMOTE" ],
          "link_settings": {
            "libraries": [
              "ws2_32.lib",
              "<(module_root_dir)/deps/winpcap/Lib/x64/wpcap.lib",
              "<(module_root_dir)/deps/winpcap/Lib/x64/Packet.lib"
            ]
          }
        }, {
          "defines": [ "_GNU_SOURCE" ],
          "cflags_cc": [ "-O2", "-std=c++20" ]
        } ]
      ]
    }
  ]
}
