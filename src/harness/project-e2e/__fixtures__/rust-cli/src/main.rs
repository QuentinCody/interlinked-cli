// orders CLI (Rust) — public executable of the fixture project.
// `add <name>` appends a line to data/orders.txt and prints the order as JSON.
// No dependencies: the "JSON" is a fixed-shape string so the fixture builds offline.
use std::env;
use std::fs;
use std::process::ExitCode;

fn count() -> usize {
    fs::read_to_string("data/orders.txt").map(|s| s.lines().count()).unwrap_or(0)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, name] if cmd == "add" => {
            let id = count() + 1;
            fs::create_dir_all("data").expect("data dir");
            let mut content = fs::read_to_string("data/orders.txt").unwrap_or_default();
            content.push_str(&format!("{id}:{name}\n"));
            fs::write("data/orders.txt", content).expect("write");
            println!("{{\"ok\":true,\"order\":{{\"id\":{id},\"name\":\"{name}\"}}}}");
            ExitCode::SUCCESS
        }
        [cmd] if cmd == "list" => {
            print!("{}", fs::read_to_string("data/orders.txt").unwrap_or_default());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: orders_cli add <name> | list");
            ExitCode::from(2)
        }
    }
}
